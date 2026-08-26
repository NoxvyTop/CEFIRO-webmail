import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../../core/errors";
import {
  JmapMethodError,
  type JmapAuth,
  type JmapClient,
  type JmapMethodCall,
  type JmapMethodResponse,
  type JmapSession,
} from "../../../infra/jmap/client";
import type { MailSessionResult } from "../context";
import {
  DELIVERY_MAX_PAGES,
  electWatcher,
  runDeliveryCycle,
  type DeliveryDeps,
  type SharedCopyMember,
} from "./delivery";

// GH #313: one delivery cycle for one shared mailbox. These pin the contract
// the worker relies on: a watcher elected from the opted-in members, a
// cursor that is baselined silently and advanced page by page, only inbox
// mail copied, every member served with their own credential, dedup before
// every copy, and one member's failure never costing another their copy.

const SHARED = "acc-shared";
/** This "replica" — the per-process id a cycle takes the account's lease under. */
const OWNER = "replica-under-test";

type Page = {
  created?: string[];
  newState: string;
  hasMoreChanges?: boolean;
};

function member(name: string): SharedCopyMember {
  return { userId: `uid-${name}`, email: `${name}@noxvytop.com` };
}

function sessionFor(email: string, reaches: string[]): JmapSession {
  return {
    apiUrl: "https://mail.test/jmap/",
    accountId: `personal-${email}`,
    eventSourceUrl: "https://mail.test/es",
    uploadUrl: "https://mail.test/upload/{accountId}/",
    downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    accounts: [
      { id: `personal-${email}`, name: "Me", isPersonal: true },
      ...reaches.map((id) => ({ id, name: "Shared", isPersonal: false })),
    ],
  };
}

/** In-memory stand-in for infra/repos/shared-mailbox-copies.ts. */
function fakeCopiesRepo() {
  const cursors = new Map<string, string>();
  const ledger = new Set<string>();
  const cursorWrites: string[] = [];
  const leases = new Map<string, { owner: string; until: number }>();
  const leaseLog: Array<{ op: "acquire" | "renew" | "release"; owner: string; ok: boolean }> = [];
  const key = (u: string, a: string, e: string) => `${u}|${a}|${e}`;
  return {
    cursors,
    ledger,
    cursorWrites,
    leases,
    leaseLog,
    /** Stands in for another replica holding this account's lease. */
    holdLease(accountId: string, owner = "other-replica", ttlMs = 60_000) {
      leases.set(accountId, { owner, until: Date.now() + ttlMs });
    },
    repo: {
      getCursor: async (accountId: string) => cursors.get(accountId) ?? null,
      setCursor: async (accountId: string, state: string) => {
        cursors.set(accountId, state);
        cursorWrites.push(state);
      },
      hasCopies: async (userId: string, accountId: string, ids: string[]) =>
        new Set(ids.filter((id) => ledger.has(key(userId, accountId, id)))),
      recordCopy: async (userId: string, accountId: string, emailId: string) => {
        ledger.add(key(userId, accountId, emailId));
      },
      acquireLease: async (accountId: string, owner: string, ttlMs: number) => {
        const held = leases.get(accountId);
        const ok = !held || held.until <= Date.now() || held.owner === owner;
        if (ok) leases.set(accountId, { owner, until: Date.now() + ttlMs });
        leaseLog.push({ op: "acquire", owner, ok });
        return ok;
      },
      renewLease: async (accountId: string, owner: string, ttlMs: number) => {
        const held = leases.get(accountId);
        const ok = held?.owner === owner;
        if (ok) leases.set(accountId, { owner, until: Date.now() + ttlMs });
        leaseLog.push({ op: "renew", owner, ok });
        return ok;
      },
      releaseLease: async (accountId: string, owner: string) => {
        const ok = leases.get(accountId)?.owner === owner;
        if (ok) leases.delete(accountId);
        leaseLog.push({ op: "release", owner, ok });
      },
    },
  };
}

type Harness = {
  deps: DeliveryDeps;
  requests: Array<{ auth: JmapAuth; calls: JmapMethodCall[] }>;
  copies: ReturnType<typeof fakeCopiesRepo>;
  logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }>;
  /** Pages `Email/changes` answers with, consumed in order. */
  pages: Page[];
  /** Which of the created ids sit in the shared inbox. */
  inInbox: Set<string>;
  /** Members whose Email/copy the provider refuses (notCreated). */
  refuseCopyFor: Set<string>;
  /** Members whose Email/copy makes the whole batch throw. */
  throwCopyFor: Set<string>;
  /** Members whose session lookup throws (a revoked credential). */
  sessionThrowsFor: Set<string>;
  /** Members with no stored credential. */
  noCredentialFor: Set<string>;
  /** Which shared accounts each member's session reaches (default: SHARED). */
  reaches: Map<string, string[]>;
  currentState: string;
  changesError?: string;
};

function harness(): Harness {
  const copies = fakeCopiesRepo();
  const h: Harness = {
    deps: undefined as unknown as DeliveryDeps,
    requests: [],
    copies,
    logs: [],
    pages: [],
    inInbox: new Set(),
    refuseCopyFor: new Set(),
    throwCopyFor: new Set(),
    sessionThrowsFor: new Set(),
    noCredentialFor: new Set(),
    reaches: new Map(),
    currentState: "s-now",
  };
  const jmap: JmapClient = {
    getSession: async () => {
      throw new Error("not used: sessions come from getMailSession");
    },
    request: async (auth, _session, calls) => {
      h.requests.push({ auth, calls });
      return calls.map(([name, params, callId]): JmapMethodResponse => {
        if (name === "Email/changes") {
          if (h.changesError) throw new JmapMethodError(h.changesError);
          const page = h.pages.shift();
          if (!page) throw new Error("Email/changes asked for a page the test did not script");
          return [
            "Email/changes",
            {
              accountId: params.accountId,
              oldState: params.sinceState,
              newState: page.newState,
              hasMoreChanges: page.hasMoreChanges ?? false,
              created: page.created ?? [],
              updated: [],
              destroyed: [],
            },
            callId,
          ];
        }
        if (name === "Mailbox/query") {
          const accountId = params.accountId as string;
          return ["Mailbox/query", { ids: [`inbox-${accountId}`] }, callId];
        }
        if (name === "Email/get") {
          const ids = (params.ids ?? []) as string[];
          const properties = (params.properties ?? []) as string[];
          if (properties.includes("mailboxIds")) {
            return [
              "Email/get",
              {
                state: h.currentState,
                list: ids.map((id) => ({
                  id,
                  mailboxIds: { [h.inInbox.has(id) ? `inbox-${SHARED}` : "elsewhere"]: true },
                })),
              },
              callId,
            ];
          }
          // The copy's keyword lookup, or the baseline (ids: []).
          return [
            "Email/get",
            { state: h.currentState, list: ids.map((id) => ({ id, keywords: { $seen: true } })) },
            callId,
          ];
        }
        if (name === "Email/copy") {
          if (h.throwCopyFor.has(auth.email)) throw new DomainError("stalwart_unavailable", 502, "x");
          if (h.refuseCopyFor.has(auth.email)) {
            return ["Email/copy", { notCreated: { c: { type: "overQuota" } } }, callId];
          }
          const create = params.create as { c: { id: string } };
          return ["Email/copy", { created: { c: { id: `copy-of-${create.c.id}` } } }, callId];
        }
        throw new Error(`unexpected JMAP method in test stub: ${name}`);
      });
    },
    uploadBlob: async () => "blob-id",
  };
  h.deps = {
    jmap,
    copies: copies.repo,
    leaseOwner: OWNER,
    getMailSession: async (m): Promise<MailSessionResult> => {
      if (h.sessionThrowsFor.has(m.email)) throw new DomainError("mail_auth_failed", 502, "x");
      if (h.noCredentialFor.has(m.email)) return { ok: false, reason: "mail_credentials_missing" };
      return {
        ok: true,
        auth: { email: m.email, password: `pw-${m.email}` },
        session: sessionFor(m.email, h.reaches.get(m.email) ?? [SHARED]),
      };
    },
    log: (level, msg, fields = {}) => {
      h.logs.push({ level, msg, fields });
    },
  };
  return h;
}

function copyCalls(h: Harness): Array<{ by: string; emailId: string; from: string; to: string }> {
  const found: Array<{ by: string; emailId: string; from: string; to: string }> = [];
  for (const { auth, calls } of h.requests) {
    for (const [name, params] of calls) {
      if (name !== "Email/copy") continue;
      const create = params.create as { c: { id: string } };
      found.push({
        by: auth.email,
        emailId: create.c.id,
        from: params.fromAccountId as string,
        to: params.accountId as string,
      });
    }
  }
  return found;
}

function changesCalls(h: Harness): Array<{ by: string; params: Record<string, unknown> }> {
  const found: Array<{ by: string; params: Record<string, unknown> }> = [];
  for (const { auth, calls } of h.requests) {
    for (const [name, params] of calls) {
      if (name === "Email/changes") found.push({ by: auth.email, params });
    }
  }
  return found;
}

let h: Harness;
const ana = member("ana");
const bruno = member("bruno");

beforeEach(() => {
  h = harness();
});

function run(members: SharedCopyMember[] = [ana, bruno]) {
  return runDeliveryCycle(h.deps, { sharedAccountId: SHARED, members });
}

describe("electWatcher (GH #313)", () => {
  it("elects the first member whose session reaches the shared account", async () => {
    h.reaches.set(ana.email, []); // ana lost membership
    const elected = await electWatcher(h.deps, { sharedAccountId: SHARED, members: [ana, bruno] });
    expect(elected?.member).toEqual(bruno);
    expect(elected?.auth.email).toBe(bruno.email);
  });

  it("skips a member without a credential or whose session lookup throws", async () => {
    h.noCredentialFor.add(ana.email);
    h.sessionThrowsFor.add(bruno.email);
    const carla = member("carla");
    const elected = await electWatcher(h.deps, {
      sharedAccountId: SHARED,
      members: [ana, bruno, carla],
    });
    expect(elected?.member).toEqual(carla);
    expect(h.logs.some((l) => l.level === "warn" && l.fields.userId === bruno.userId)).toBe(true);
  });

  it("returns null when nobody can reach the account", async () => {
    h.reaches.set(ana.email, []);
    h.noCredentialFor.add(bruno.email);
    expect(await electWatcher(h.deps, { sharedAccountId: SHARED, members: [ana, bruno] })).toBeNull();
  });
});

describe("runDeliveryCycle — gates (GH #313)", () => {
  it("skips with no_watcher and touches neither JMAP nor the cursor when nobody can reach the account", async () => {
    h.noCredentialFor.add(ana.email);
    h.reaches.set(bruno.email, []);
    await expect(run()).resolves.toEqual({ status: "no_watcher" });
    expect(h.requests).toHaveLength(0);
    expect(h.copies.cursorWrites).toEqual([]);
    expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("watcher"))).toBe(true);
  });

  it("yields with locked when another replica holds the account lease", async () => {
    h.copies.holdLease(SHARED);
    await expect(run()).resolves.toEqual({ status: "locked" });
    expect(h.requests).toHaveLength(0);
    // The other replica's lease is left exactly as it was — not stolen, and
    // not released by the cycle that failed to take it.
    expect(h.copies.leases.get(SHARED)?.owner).toBe("other-replica");
    expect(h.copies.leaseLog.filter((entry) => entry.op === "release")).toEqual([]);
  });

  // GH #313: the lease replaced a transaction-scoped advisory lock that held a
  // pooled connection open in a transaction for the whole cycle while every
  // query of that cycle asked the same pool for another one.
  it("takes the account lease before anything else and releases it at the end", async () => {
    h.copies.cursors.set(SHARED, "s-1");
    h.pages = [{ created: [], newState: "s-2" }];
    await run([ana]);
    expect(h.copies.leaseLog[0]).toEqual({ op: "acquire", owner: OWNER, ok: true });
    expect(h.copies.leaseLog.at(-1)).toEqual({ op: "release", owner: OWNER, ok: true });
    // Released, so the next push or poll delivers without waiting out the TTL.
    expect(h.copies.leases.has(SHARED)).toBe(false);
  });

  it("releases the account lease when the cycle throws", async () => {
    h.copies.cursors.set(SHARED, "s-1");
    h.changesError = "serverUnavailable";
    await expect(run([ana])).rejects.toMatchObject({ code: "jmap_error" });
    expect(h.copies.leases.has(SHARED)).toBe(false);
  });

  it("renews the lease after each page, and stops delivering once it is lost", async () => {
    h.copies.cursors.set(SHARED, "s-1");
    h.pages = [
      { created: [], newState: "s-2", hasMoreChanges: true },
      { created: ["e1"], newState: "s-3" },
    ];
    h.inInbox.add("e1");
    await expect(run([ana])).resolves.toMatchObject({ pages: 2, copied: 1 });
    expect(h.copies.leaseLog.filter((entry) => entry.op === "renew")).toEqual([
      { op: "renew", owner: OWNER, ok: true },
    ]);

    // Another replica takes the account over between pages: this cycle stops
    // rather than delivering the same pages alongside it.
    h = harness();
    h.copies.cursors.set(SHARED, "s-1");
    h.pages = [
      { created: [], newState: "s-2", hasMoreChanges: true },
      { created: ["e1"], newState: "s-3" },
    ];
    h.inInbox.add("e1");
    const original = h.deps.copies.renewLease;
    h.deps.copies.renewLease = async (accountId, owner, ttl) => {
      h.copies.holdLease(accountId, "other-replica");
      return original(accountId, owner, ttl);
    };
    await expect(run([ana])).resolves.toMatchObject({ pages: 1, copied: 0 });
    expect(h.copies.cursors.get(SHARED)).toBe("s-2");
    expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("lease lost"))).toBe(true);
  });

  it("baselines the current Email state without copying when there is no cursor yet", async () => {
    h.currentState = "s-42";
    await expect(run()).resolves.toEqual({ status: "baselined", reason: "no_cursor" });
    expect(h.copies.cursors.get(SHARED)).toBe("s-42");
    expect(copyCalls(h)).toEqual([]);
    expect(changesCalls(h)).toEqual([]);
    // The baseline read is an Email/get with no ids on the SHARED account —
    // the cheapest call that returns the account's state.
    const baseline = h.requests[0]!.calls[0]!;
    expect(baseline[0]).toBe("Email/get");
    expect(baseline[1]).toMatchObject({ accountId: SHARED, ids: [] });
  });

  it("re-baselines and copies nothing when the provider cannot calculate changes from the cursor", async () => {
    h.copies.cursors.set(SHARED, "s-ancient");
    h.currentState = "s-fresh";
    h.changesError = "cannotCalculateChanges";
    await expect(run()).resolves.toEqual({
      status: "baselined",
      reason: "cannot_calculate_changes",
    });
    expect(h.copies.cursors.get(SHARED)).toBe("s-fresh");
    expect(copyCalls(h)).toEqual([]);
    expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("baselin"))).toBe(true);
  });

  it("keeps the cursor and propagates any other method error, so the page is retried later", async () => {
    h.copies.cursors.set(SHARED, "s-1");
    h.changesError = "serverUnavailable";
    await expect(run()).rejects.toMatchObject({ code: "jmap_error" });
    expect(h.copies.cursors.get(SHARED)).toBe("s-1");
  });
});

describe("runDeliveryCycle — delivery (GH #313)", () => {
  beforeEach(() => {
    h.copies.cursors.set(SHARED, "s-1");
  });

  it("asks for changes since the cursor with the elected watcher's credential", async () => {
    h.pages = [{ created: [], newState: "s-2" }];
    await run();
    expect(changesCalls(h)).toEqual([
      { by: ana.email, params: { accountId: SHARED, sinceState: "s-1", maxChanges: 100 } },
    ]);
  });

  it("copies each new inbox message to every opted-in member with that member's own credential", async () => {
    h.pages = [{ created: ["e1", "e2"], newState: "s-2" }];
    h.inInbox.add("e1").add("e2");

    await expect(run()).resolves.toEqual({
      status: "delivered",
      copied: 4,
      skipped: 0,
      failed: 0,
      pages: 1,
      truncated: false,
    });
    expect(copyCalls(h)).toEqual([
      { by: ana.email, emailId: "e1", from: SHARED, to: `personal-${ana.email}` },
      { by: ana.email, emailId: "e2", from: SHARED, to: `personal-${ana.email}` },
      { by: bruno.email, emailId: "e1", from: SHARED, to: `personal-${bruno.email}` },
      { by: bruno.email, emailId: "e2", from: SHARED, to: `personal-${bruno.email}` },
    ]);
    expect(h.copies.cursors.get(SHARED)).toBe("s-2");
  });

  it("records each confirmed copy in the ledger", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    await run();
    expect(await h.copies.repo.hasCopies(ana.userId, SHARED, ["e1"])).toEqual(new Set(["e1"]));
    expect(await h.copies.repo.hasCopies(bruno.userId, SHARED, ["e1"])).toEqual(new Set(["e1"]));
  });

  it("copies only mail sitting in the shared inbox, resolved with one read batch", async () => {
    h.pages = [{ created: ["e-inbox", "e-sent", "e-draft"], newState: "s-2" }];
    h.inInbox.add("e-inbox");

    const result = await run([ana]);
    expect(result).toMatchObject({ status: "delivered", copied: 1 });
    expect(copyCalls(h).map((c) => c.emailId)).toEqual(["e-inbox"]);

    const lookup = h.requests.find(({ calls }) => calls.some(([name]) => name === "Mailbox/query"))!;
    expect(lookup.calls.map(([name]) => name)).toEqual(["Mailbox/query", "Email/get"]);
    expect(lookup.calls[0]![1]).toEqual({ accountId: SHARED, filter: { role: "inbox" } });
    expect(lookup.calls[1]![1]).toEqual({
      accountId: SHARED,
      ids: ["e-inbox", "e-sent", "e-draft"],
      properties: ["mailboxIds"],
    });
  });

  it("skips a member who already holds a copy and still serves the others", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    await h.copies.repo.recordCopy(ana.userId, SHARED, "e1");

    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 1, skipped: 1 });
    expect(copyCalls(h).map((c) => c.by)).toEqual([bruno.email]);
  });

  it("skips a member whose session no longer reaches the shared account, with a log line", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    h.reaches.set(bruno.email, []);

    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 1, failed: 0 });
    expect(copyCalls(h).map((c) => c.by)).toEqual([ana.email]);
    expect(
      h.logs.some((l) => l.level === "info" && l.fields.userId === bruno.userId && l.msg.includes("member")),
    ).toBe(true);
  });

  it("counts a refused copy as failed, leaves it out of the ledger and still serves the others", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    h.refuseCopyFor.add(ana.email);

    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 1, failed: 1 });
    expect(await h.copies.repo.hasCopies(ana.userId, SHARED, ["e1"])).toEqual(new Set());
    expect(await h.copies.repo.hasCopies(bruno.userId, SHARED, ["e1"])).toEqual(new Set(["e1"]));
    expect(h.logs.some((l) => l.level === "warn" && l.fields.userId === ana.userId)).toBe(true);
  });

  it("counts a copy whose JMAP call throws as failed and still serves the others", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    h.throwCopyFor.add(ana.email);

    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 1, failed: 1 });
    // Both were attempted; only bruno's is in the ledger.
    expect(copyCalls(h).map((c) => c.by)).toEqual([ana.email, bruno.email]);
    expect(await h.copies.repo.hasCopies(ana.userId, SHARED, ["e1"])).toEqual(new Set());
    expect(await h.copies.repo.hasCopies(bruno.userId, SHARED, ["e1"])).toEqual(new Set(["e1"]));
    // The cursor still advances: the ledger, not the cursor, is what protects
    // ana's copy on the next cycle — and nothing would ever re-deliver it if
    // the page stayed pinned behind one member's failure.
    expect(h.copies.cursors.get(SHARED)).toBe("s-2");
  });

  it("serves a member whose session lookup throws nothing this cycle, without failing the others", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    h.sessionThrowsFor.add(bruno.email);

    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 1 });
    expect(copyCalls(h).map((c) => c.by)).toEqual([ana.email]);
  });

  it("advances the cursor after each page and follows hasMoreChanges", async () => {
    h.pages = [
      { created: ["e1"], newState: "s-2", hasMoreChanges: true },
      { created: ["e2"], newState: "s-3" },
    ];
    h.inInbox.add("e1").add("e2");

    await expect(run([ana])).resolves.toMatchObject({ status: "delivered", copied: 2, pages: 2 });
    expect(h.copies.cursorWrites).toEqual(["s-2", "s-3"]);
    expect(changesCalls(h).map((c) => c.params.sinceState)).toEqual(["s-1", "s-2"]);
  });

  it("stops after the page cap and reports the cycle as truncated, leaving the rest for the next one", async () => {
    h.pages = Array.from({ length: DELIVERY_MAX_PAGES + 2 }, (_, i) => ({
      created: [],
      newState: `s-${i + 2}`,
      hasMoreChanges: true,
    }));

    await expect(run([ana])).resolves.toMatchObject({
      status: "delivered",
      pages: DELIVERY_MAX_PAGES,
      truncated: true,
    });
    expect(h.copies.cursors.get(SHARED)).toBe(`s-${DELIVERY_MAX_PAGES + 1}`);
    expect(h.pages).toHaveLength(2);
  });

  it("advances the cursor without any read batch when a page created nothing", async () => {
    h.pages = [{ created: [], newState: "s-2" }];
    await run([ana]);
    expect(h.requests.some(({ calls }) => calls.some(([name]) => name === "Mailbox/query"))).toBe(false);
    expect(h.copies.cursors.get(SHARED)).toBe("s-2");
  });

  it("fails the cycle, keeping the cursor, when the shared inbox cannot be resolved", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    const original = h.deps.jmap.request;
    h.deps.jmap.request = async (auth, session, calls) => {
      const responses = await original(auth, session, calls);
      return responses.map(([name, args, id]): JmapMethodResponse =>
        name === "Mailbox/query" ? [name, { ids: [] }, id] : [name, args, id],
      );
    };
    await expect(run([ana])).rejects.toThrow(/inbox/);
    expect(h.copies.cursors.get(SHARED)).toBe("s-1");
  });
});
