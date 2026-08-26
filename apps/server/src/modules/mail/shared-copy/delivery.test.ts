import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../../core/errors";
import {
  JmapMethodError,
  type JmapAuth,
  type JmapClient,
  type JmapMethodCall,
  type JmapMethodResponse,
  type JmapRequestOptions,
  type JmapSession,
} from "../../../infra/jmap/client";
import type { MailSessionResult } from "../context";
import {
  DELIVERY_BASELINE_SKEW_MS,
  DELIVERY_MAX_PAGES,
  DELIVERY_RETRY_MAX_ATTEMPTS,
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
function fakeCopiesRepo(events: string[]) {
  const cursors = new Map<string, string>();
  const cycledAt = new Map<string, number>();
  /** (member|account|email) → ledger status, exactly like the real table. */
  const states = new Map<string, "pending" | "copied" | "failed">();
  const attempts = new Map<string, number>();
  const errors = new Map<string, string>();
  /** The source Message-ID each ledger row carries, exactly like the column. */
  const messageIds = new Map<string, string | null>();
  /** The source receivedAt each ledger row carries, exactly like the column. */
  const receivedAts = new Map<string, Date | null>();
  /** Insertion order of the failed rows, standing in for `order by updated_at`. */
  const failedOrder: string[] = [];
  const cursorWrites: string[] = [];
  /** Accounts whose cycle stamped an attempt, in order. */
  const cycleAttempts: string[] = [];
  /** The member ids each listRetryable call was scoped to. */
  const retryQueries: string[][] = [];
  let failMarkCopied = 0;
  const leases = new Map<string, { owner: string; until: number }>();
  const leaseLog: Array<{ op: "acquire" | "renew" | "release"; owner: string; ok: boolean }> = [];
  /** Members this account has already baselined, per account, and from when. */
  const memberState = new Map<string, Map<string, Date>>();
  const key = (u: string, a: string, e: string) => `${u}|${a}|${e}`;
  /**
   * The real prune, in miniature (see infra/repos/shared-mailbox-copies.ts):
   * a member this account no longer has loses their baseline row AND their
   * open ledger rows, while the confirmed ones stay as dedup history.
   */
  function prune(accountId: string, userIds: string[]): void {
    const seen = memberState.get(accountId) ?? new Map<string, Date>();
    memberState.set(accountId, seen);
    for (const known of [...seen.keys()]) {
      if (userIds.includes(known)) continue;
      seen.delete(known);
      for (const id of [...states.keys()]) {
        const [userId, account] = id.split("|") as [string, string];
        if (userId !== known || account !== accountId) continue;
        if (states.get(id) === "copied") continue;
        states.delete(id);
        attempts.delete(id);
        errors.delete(id);
      }
    }
  }
  return {
    cursors,
    cycledAt,
    states,
    attempts,
    errors,
    cursorWrites,
    cycleAttempts,
    retryQueries,
    messageIds,
    receivedAts,
    /**
     * A copy an earlier cycle failed `attemptCount` times, with the source's
     * Message-ID as that cycle recorded it (null when the source had none) and
     * its receivedAt (default: just now, i.e. after any seeded baseline).
     */
    seedFailed(
      userId: string,
      accountId: string,
      emailId: string,
      attemptCount: number,
      messageId: string | null = `mid-${emailId}`,
      receivedAt: Date | null = new Date(),
    ) {
      const id = key(userId, accountId, emailId);
      states.set(id, "failed");
      attempts.set(id, attemptCount);
      errors.set(id, "copy_failed");
      messageIds.set(id, messageId);
      receivedAts.set(id, receivedAt);
      if (!failedOrder.includes(id)) failedOrder.push(id);
    },
    leases,
    leaseLog,
    memberState,
    /** The next markCopied rejects — a database blip after a confirmed copy. */
    failMarkCopiedOnce() {
      failMarkCopied += 1;
    },
    /** Stands in for another replica holding this account's lease. */
    holdLease(accountId: string, owner = "other-replica", ttlMs = 60_000) {
      leases.set(accountId, { owner, until: Date.now() + ttlMs });
    },
    /** A cursor a cycle left behind just now: the normal resume case. */
    seedCursor(accountId: string, state: string) {
      cursors.set(accountId, state);
      cycledAt.set(accountId, Date.now());
    },
    /** A cursor last touched `ageMs` ago — a worker that was off that long. */
    ageCursor(accountId: string, ageMs: number) {
      cycledAt.set(accountId, Date.now() - ageMs);
    },
    /** How old this account's `last_cycle_at` stamp is right now. */
    cursorAgeMs(accountId: string): number {
      return Date.now() - (cycledAt.get(accountId) ?? 0);
    },
    /** Members this account has already baselined. */
    baselined(accountId: string): string[] {
      return [...(memberState.get(accountId)?.keys() ?? [])];
    },
    /** When this member was baselined for the account, if at all. */
    baselineOf(accountId: string, userId: string): Date | undefined {
      return memberState.get(accountId)?.get(userId);
    },
    /**
     * Members baselined by an earlier cycle at `at` (default: a minute ago, so
     * a message received "now" is theirs to receive).
     */
    seedMembers(accountId: string, userIds: string[], at = new Date(Date.now() - 60_000)) {
      const seen = memberState.get(accountId) ?? new Map<string, Date>();
      memberState.set(accountId, seen);
      for (const userId of userIds) seen.set(userId, at);
    },
    repo: {
      getCursor: async (accountId: string) => cursors.get(accountId) ?? null,
      getState: async (accountId: string) => ({
        emailState: cursors.get(accountId) ?? null,
        lastCycleAt: cycledAt.has(accountId) ? new Date(cycledAt.get(accountId)!) : null,
      }),
      markCycleAttempt: async (accountId: string) => {
        cycleAttempts.push(accountId);
        cycledAt.set(accountId, Date.now());
      },
      listAccountIds: async () => [...new Set([...cursors.keys(), ...memberState.keys()])],
      pruneMembers: async (accountId: string, userIds: string[]) => {
        prune(accountId, userIds);
      },
      baselineMembers: async (accountId: string, userIds: string[]) => {
        // Records only: pruning is the worker's, against the preference
        // listing, exactly as in the real repo.
        const seen = memberState.get(accountId) ?? new Map<string, Date>();
        memberState.set(accountId, seen);
        const now = new Date();
        const baselines = new Map<string, Date>();
        for (const userId of userIds) {
          if (!seen.has(userId)) seen.set(userId, now);
          baselines.set(userId, seen.get(userId)!);
        }
        return baselines;
      },
      setCursor: async (accountId: string, state: string) => {
        cursors.set(accountId, state);
        cycledAt.set(accountId, Date.now());
        cursorWrites.push(state);
      },
      hasCopies: async (userId: string, accountId: string, ids: string[]) =>
        new Set(ids.filter((id) => states.get(key(userId, accountId, id)) === "copied")),
      copyStates: async (userId: string, accountId: string, ids: string[]) => {
        const found = new Map<string, "pending" | "copied" | "failed">();
        for (const id of ids) {
          const status = states.get(key(userId, accountId, id));
          if (status) found.set(id, status);
        }
        return found;
      },
      beginCopy: async (
        userId: string,
        accountId: string,
        emailId: string,
        messageId?: string | null,
        receivedAt?: Date | null,
      ) => {
        events.push(`ledger:begin:${userId}:${emailId}`);
        const id = key(userId, accountId, emailId);
        // Never erased by a claim that does not know them (the retry pass).
        if (messageId != null || !messageIds.has(id)) messageIds.set(id, messageId ?? null);
        if (receivedAt != null || !receivedAts.has(id)) receivedAts.set(id, receivedAt ?? null);
        if (states.get(id) === "copied") return;
        states.set(id, "pending");
      },
      markCopied: async (userId: string, accountId: string, emailId: string) => {
        events.push(`ledger:copied:${userId}:${emailId}`);
        if (failMarkCopied > 0) {
          failMarkCopied -= 1;
          throw new Error("database unavailable");
        }
        states.set(key(userId, accountId, emailId), "copied");
      },
      markFailed: async (
        userId: string,
        accountId: string,
        emailId: string,
        lastError: string,
      ) => {
        const id = key(userId, accountId, emailId);
        events.push(`ledger:failed:${userId}:${emailId}`);
        states.set(id, "failed");
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        errors.set(id, lastError);
        // `updated_at = now()`: a row that just failed again goes to the tail
        // of the oldest-first batch, exactly as the real `order by` puts it.
        const at = failedOrder.indexOf(id);
        if (at >= 0) failedOrder.splice(at, 1);
        failedOrder.push(id);
      },
      listRetryable: async (
        accountId: string,
        options: { userIds: string[]; maxAttempts: number; limit: number },
      ) => {
        retryQueries.push(options.userIds);
        const rows: Array<{
          userId: string;
          emailId: string;
          attempts: number;
          messageId: string | null;
          receivedAt: Date | null;
        }> = [];
        for (const id of failedOrder) {
          if (rows.length >= options.limit) break;
          const [userId, account, emailId] = id.split("|") as [string, string, string];
          if (account !== accountId) continue;
          if (!options.userIds.includes(userId)) continue;
          if (states.get(id) !== "failed") continue;
          const tries = attempts.get(id) ?? 0;
          if (tries >= options.maxAttempts) continue;
          rows.push({
            userId,
            emailId,
            attempts: tries,
            messageId: messageIds.get(id) ?? null,
            receivedAt: receivedAts.get(id) ?? null,
          });
        }
        return rows;
      },
      recordCopy: async (userId: string, accountId: string, emailId: string) => {
        states.set(key(userId, accountId, emailId), "copied");
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
  requests: Array<{ auth: JmapAuth; calls: JmapMethodCall[]; options?: JmapRequestOptions }>;
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
  /** Keywords the shared account reports for a message (default: $seen). */
  keywordsFor: Map<string, Record<string, boolean>>;
  /** Members whose PERSONAL inbox the provider cannot resolve. */
  noPersonalInboxFor: Set<string>;
  /**
   * The `messageId` the shared account reports for a message — RFC 8621
   * `asMessageIds`, i.e. WITHOUT the angle brackets, exactly as the
   * inReplyTo/references fixtures of send.test.ts (default: one per id; null =
   * no header).
   */
  messageIdFor: Map<string, string[] | null>;
  /** A provider that never returns `messageId`, however it is asked. */
  omitMessageId: boolean;
  /** When the shared account received each message (default: now, at read time). */
  receivedAtFor: Map<string, Date>;
  /** A provider that answers the page read without `receivedAt` (an RFC 8621 violation). */
  omitReceivedAt: boolean;
  /**
   * `${member email}|<Message-ID>` pairs already sitting in that member's
   * inbox, keyed by the RAW header value (brackets included), which is what a
   * `header` filter compares against.
   */
  personalCopies: Set<string>;
  /** Members whose personal Email/query throws. */
  queryThrowsFor: Set<string>;
  /** Message-IDs (as sent in the header filter) whose Email/query throws, for anybody. */
  queryThrowsForMessageId: Set<string>;
  /** Every Email/query the verification made, in order. */
  verifications: Array<{ by: string; messageId: string; inMailbox: string }>;
  /** Ledger writes and Email/copy calls, in the order they happened. */
  events: string[];
  currentState: string;
  changesError?: string;
};

function harness(): Harness {
  const events: string[] = [];
  const copies = fakeCopiesRepo(events);
  const h: Harness = {
    deps: undefined as unknown as DeliveryDeps,
    requests: [],
    copies,
    events,
    logs: [],
    pages: [],
    inInbox: new Set(),
    refuseCopyFor: new Set(),
    throwCopyFor: new Set(),
    sessionThrowsFor: new Set(),
    noCredentialFor: new Set(),
    reaches: new Map(),
    keywordsFor: new Map(),
    noPersonalInboxFor: new Set(),
    messageIdFor: new Map(),
    omitMessageId: false,
    receivedAtFor: new Map(),
    omitReceivedAt: false,
    personalCopies: new Set(),
    queryThrowsFor: new Set(),
    queryThrowsForMessageId: new Set(),
    verifications: [],
    currentState: "s-now",
  };
  const jmap: JmapClient = {
    getSession: async () => {
      throw new Error("not used: sessions come from getMailSession");
    },
    request: async (auth, _session, calls, _extraUsing, options) => {
      h.requests.push({ auth, calls, options });
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
          const owner = accountId.startsWith("personal-") ? accountId.slice("personal-".length) : "";
          if (owner && h.noPersonalInboxFor.has(owner)) {
            return ["Mailbox/query", { ids: [] }, callId];
          }
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
                  ...(properties.includes("keywords")
                    ? { keywords: h.keywordsFor.get(id) ?? { $seen: true } }
                    : {}),
                  ...(properties.includes("messageId") && !h.omitMessageId
                    ? { messageId: h.messageIdFor.has(id) ? h.messageIdFor.get(id) : [`mid-${id}`] }
                    : {}),
                  ...(properties.includes("receivedAt") && !h.omitReceivedAt
                    ? { receivedAt: (h.receivedAtFor.get(id) ?? new Date()).toISOString() }
                    : {}),
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
        if (name === "Email/query") {
          // The retry pass looking for a copy it may already have made, by the
          // source's Message-ID, in the member's own inbox. A `header` filter
          // (RFC 8621 §4.4.1) compares against the RAW header value — with the
          // angle brackets — so `messageId` here is the bracketed form.
          const filter = params.filter as { inMailbox: string; header: [string, string] };
          const messageId = filter.header[1];
          h.verifications.push({ by: auth.email, messageId, inMailbox: filter.inMailbox });
          if (h.queryThrowsFor.has(auth.email) || h.queryThrowsForMessageId.has(messageId)) {
            throw new DomainError("stalwart_unavailable", 502, "x");
          }
          return [
            "Email/query",
            { ids: h.personalCopies.has(`${auth.email}|${messageId}`) ? ["already-there"] : [] },
            callId,
          ];
        }
        if (name === "Email/copy") {
          const created = params.create as { c: { id: string } };
          events.push(`jmap:Email/copy:${auth.email}:${created.c.id}`);
          if (h.throwCopyFor.has(auth.email)) throw new DomainError("stalwart_unavailable", 502, "x");
          if (h.refuseCopyFor.has(auth.email)) {
            return ["Email/copy", { notCreated: { c: { type: "overQuota" } } }, callId];
          }
          return ["Email/copy", { created: { c: { id: `copy-of-${created.c.id}` } } }, callId];
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
    h.copies.seedCursor(SHARED, "s-1");
    h.pages = [{ created: [], newState: "s-2" }];
    await run([ana]);
    expect(h.copies.leaseLog[0]).toEqual({ op: "acquire", owner: OWNER, ok: true });
    expect(h.copies.leaseLog.at(-1)).toEqual({ op: "release", owner: OWNER, ok: true });
    // Released, so the next push or poll delivers without waiting out the TTL.
    expect(h.copies.leases.has(SHARED)).toBe(false);
  });

  it("releases the account lease when the cycle throws", async () => {
    h.copies.seedCursor(SHARED, "s-1");
    h.changesError = "serverUnavailable";
    await expect(run([ana])).rejects.toMatchObject({ code: "jmap_error" });
    expect(h.copies.leases.has(SHARED)).toBe(false);
  });

  // GH #313: the lease was renewed only BETWEEN pages, so a page that took
  // longer than the ten-minute TTL let another replica acquire the account
  // mid-page and copy the very same messages — the ledger is read once per
  // member per page, so neither cycle could see the other's claims in time.
  // Every member's batch renews now.
  it("renews the lease after every member's batch, not only between pages", async () => {
    h.copies.seedCursor(SHARED, "s-1");
    h.copies.seedMembers(SHARED, [ana.userId, bruno.userId]);
    h.pages = [
      { created: ["e1"], newState: "s-2", hasMoreChanges: true },
      { created: ["e2"], newState: "s-3" },
    ];
    h.inInbox.add("e1").add("e2");

    await expect(run()).resolves.toMatchObject({ pages: 2, copied: 4 });
    // Two members on each of two pages, plus the one between the pages.
    expect(h.copies.leaseLog.filter((entry) => entry.op === "renew")).toHaveLength(5);
    expect(h.copies.leaseLog.every((entry) => entry.owner === OWNER)).toBe(true);
  });

  it("stops copying the rest of the page the moment the lease is lost", async () => {
    h.copies.seedCursor(SHARED, "s-1");
    h.copies.seedMembers(SHARED, [ana.userId, bruno.userId]);
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    // Another replica takes the account over while ana's batch is running.
    const original = h.deps.copies.renewLease;
    h.deps.copies.renewLease = async (accountId, owner, ttl) => {
      h.copies.holdLease(accountId, "other-replica");
      return original(accountId, owner, ttl);
    };

    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 1 });
    // Bruno's copy belongs to whoever owns the account now, not to this cycle.
    expect(copyCalls(h).map((c) => c.by)).toEqual([ana.email]);
    // The cursor stays put: the new holder re-reads this page, and the ledger
    // turns the copy this cycle did make into a skip rather than a duplicate.
    expect(h.copies.cursors.get(SHARED)).toBe("s-1");
    expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("lease lost"))).toBe(true);
  });

  it("stops delivering when the lease is lost between pages", async () => {
    h.copies.seedCursor(SHARED, "s-1");
    h.copies.seedMembers(SHARED, [ana.userId]);
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
    // This page's copies were made before the loss, so its cursor stands.
    expect(h.copies.cursors.get(SHARED)).toBe("s-2");
    expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("lease lost"))).toBe(true);
  });

  it("stops before any new page when the lease is lost during the retry pass", async () => {
    h.copies.seedCursor(SHARED, "s-1");
    h.copies.seedMembers(SHARED, [ana.userId, bruno.userId]);
    h.copies.seedFailed(ana.userId, SHARED, "e-old", 1);
    h.copies.seedFailed(bruno.userId, SHARED, "e-old-b", 1);
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    const original = h.deps.copies.renewLease;
    h.deps.copies.renewLease = async (accountId, owner, ttl) => {
      h.copies.holdLease(accountId, "other-replica");
      return original(accountId, owner, ttl);
    };

    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 1, pages: 0 });
    expect(copyCalls(h).map((c) => c.emailId)).toEqual(["e-old"]);
    expect(changesCalls(h)).toEqual([]);
    expect(h.copies.cursors.get(SHARED)).toBe("s-1");
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
    h.copies.seedCursor(SHARED, "s-ancient");
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
    h.copies.seedCursor(SHARED, "s-1");
    h.changesError = "serverUnavailable";
    await expect(run()).rejects.toMatchObject({ code: "jmap_error" });
    expect(h.copies.cursors.get(SHARED)).toBe("s-1");
  });
});

// GH #313: delivery used to re-baseline whenever the cursor had not moved in
// two poll intervals, which silently dropped EVERY message of any gap longer
// than that — a provider outage, a deploy, an account with no watcher, a cycle
// error the worker swallowed. Time cannot tell an intentional pause from an
// outage, so there is no time-based rule at all any more: the cursor is always
// resumed, and the per-member baseline is the only thing that keeps an opt-in
// from back-filling.
describe("runDeliveryCycle — resuming after a gap and per-member baseline (GH #313)", () => {
  it("delivers the backlog from the persisted cursor after an hour with no cycle", async () => {
    h.copies.seedCursor(SHARED, "s-old");
    h.copies.seedMembers(SHARED, [ana.userId, bruno.userId]);
    h.copies.ageCursor(SHARED, 3_600_000);
    h.pages = [{ created: ["e1", "e2"], newState: "s-now" }];
    h.inInbox.add("e1").add("e2");

    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 4 });
    expect(changesCalls(h).map((c) => c.params.sinceState)).toEqual(["s-old"]);
    expect(h.copies.cursors.get(SHARED)).toBe("s-now");
  });

  it("resumes from a cursor no cycle ever stamped, rather than throwing it away", async () => {
    // A row written before `last_cycle_at` existed, or one whose stamp a
    // failed cycle never wrote: the cursor itself is still the truth.
    h.copies.cursors.set(SHARED, "s-unstamped");
    h.copies.seedMembers(SHARED, [ana.userId]);
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");

    await expect(run([ana])).resolves.toMatchObject({ status: "delivered", copied: 1 });
    expect(changesCalls(h).map((c) => c.params.sinceState)).toEqual(["s-unstamped"]);
  });

  // `last_cycle_at` survives as an informational stamp only: it says when a
  // cycle was last ATTEMPTED, so it is written as soon as the lease is taken
  // rather than on a successful advance — a run that reached no member, or
  // threw, is still a run the operator wants to see.
  it("stamps the attempt as soon as the lease is taken", async () => {
    h.copies.seedCursor(SHARED, "s-1");
    h.copies.ageCursor(SHARED, 3_600_000);
    h.pages = [{ created: [], newState: "s-2" }];

    await run([ana]);
    expect(h.copies.cycleAttempts).toEqual([SHARED]);
    expect(h.copies.cursorAgeMs(SHARED)).toBeLessThan(60_000);
  });

  it("stamps the attempt even when no member can reach the account", async () => {
    h.noCredentialFor.add(ana.email);
    await expect(run([ana])).resolves.toEqual({ status: "no_watcher" });
    expect(h.copies.cycleAttempts).toEqual([SHARED]);
    expect(h.copies.cursorWrites).toEqual([]);
  });

  it("stamps no attempt for a cycle it never ran, because another replica holds the lease", async () => {
    h.copies.holdLease(SHARED);
    await expect(run([ana])).resolves.toEqual({ status: "locked" });
    expect(h.copies.cycleAttempts).toEqual([]);
  });

  // GH #313: the joiner's baseline used to be an opaque Email state that was
  // recorded and never compared, so it only ever excluded the joiner from ONE
  // cycle — and an account with a backlog longer than that cycle's page cap
  // handed them the rest of the pre-opt-in mail from the next cycle on. The
  // baseline is a timestamp now, compared against every message's receivedAt.
  it("gives a joiner only the mail received after their opt-in, across a backlog of several cycles", async () => {
    const now = Date.now();
    h.copies.seedCursor(SHARED, "s-1");
    h.copies.seedMembers(SHARED, [ana.userId], new Date(now - 4 * 3_600_000));
    // Bruno opts in right now, with three hours of undelivered backlog behind
    // the cursor: two pages this cycle, one more (plus fresh mail) the next.
    h.receivedAtFor.set("e1", new Date(now - 3 * 3_600_000));
    h.receivedAtFor.set("e2", new Date(now - 2 * 3_600_000));
    h.receivedAtFor.set("e3", new Date(now - 3_600_000));
    h.receivedAtFor.set("e4", new Date(now + 5_000));
    h.inInbox.add("e1").add("e2").add("e3").add("e4");
    h.pages = [
      { created: ["e1"], newState: "s-2", hasMoreChanges: true },
      { created: ["e2"], newState: "s-3" },
    ];

    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 2, pages: 2 });
    expect(copyCalls(h).map((c) => c.by)).toEqual([ana.email, ana.email]);
    expect(h.copies.baselineOf(SHARED, bruno.userId)!.getTime()).toBeGreaterThanOrEqual(now);

    h.pages = [{ created: ["e3", "e4"], newState: "s-4" }];
    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 3 });
    expect(copyCalls(h).filter((c) => c.by === bruno.email).map((c) => c.emailId)).toEqual(["e4"]);
    expect(copyCalls(h).filter((c) => c.by === ana.email).map((c) => c.emailId)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
  });

  it("delivers mail that arrives during the very cycle a member joins", async () => {
    h.copies.seedCursor(SHARED, "s-1");
    h.copies.seedMembers(SHARED, [ana.userId]); // bruno opts in right now
    h.receivedAtFor.set("e1", new Date(Date.now() + 1_000));
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");

    // No one-cycle exclusion: it would cost the joiner exactly this message.
    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 2 });
    expect(copyCalls(h).map((c) => c.by)).toEqual([ana.email, bruno.email]);
  });

  it("allows a minute of clock skew between the provider and the database", async () => {
    const now = Date.now();
    h.copies.seedCursor(SHARED, "s-1");
    h.copies.seedMembers(SHARED, [ana.userId], new Date(now));
    h.receivedAtFor.set("e-skew", new Date(now - DELIVERY_BASELINE_SKEW_MS + 5_000));
    h.receivedAtFor.set("e-older", new Date(now - DELIVERY_BASELINE_SKEW_MS - 5_000));
    h.pages = [{ created: ["e-skew", "e-older"], newState: "s-2" }];
    h.inInbox.add("e-skew").add("e-older");

    await expect(run([ana])).resolves.toMatchObject({ copied: 1 });
    expect(copyCalls(h).map((c) => c.emailId)).toEqual(["e-skew"]);
  });

  it("fails the cycle, keeping the cursor, when the provider returns no receivedAt", async () => {
    h.copies.seedCursor(SHARED, "s-1");
    h.copies.seedMembers(SHARED, [ana.userId]);
    h.omitReceivedAt = true;
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");

    // Without it no message can be placed against any baseline, so — like an
    // unresolvable inbox — the page is retried rather than guessed at.
    await expect(run([ana])).rejects.toThrow(/receivedAt/);
    expect(copyCalls(h)).toEqual([]);
    expect(h.copies.cursors.get(SHARED)).toBe("s-1");
  });

  it("baselines every member of an account whose first cycle only recorded the state", async () => {
    h.currentState = "s-42";
    await expect(run()).resolves.toEqual({ status: "baselined", reason: "no_cursor" });
    expect(new Set(h.copies.baselined(SHARED))).toEqual(new Set([ana.userId, bruno.userId]));

    h.pages = [{ created: ["e1"], newState: "s-43" }];
    h.inInbox.add("e1");
    await expect(run()).resolves.toMatchObject({ status: "delivered", copied: 2 });
  });

  it("re-baselines a member who opted out and back in, instead of back-filling the gap", async () => {
    const now = Date.now();
    h.copies.seedCursor(SHARED, "s-1");
    h.copies.seedMembers(SHARED, [ana.userId, bruno.userId], new Date(now - 3_600_000));

    // Bruno opts out: the worker prunes him against the preference listing
    // and the cycle runs for ana alone.
    await h.copies.repo.pruneMembers(SHARED, [ana.userId]);
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    await expect(run([ana])).resolves.toMatchObject({ copied: 1 });
    expect(h.copies.baselined(SHARED)).toEqual([ana.userId]);

    // He opts back in with a fresh baseline: the mail that arrived while he
    // was out is not copied to him, the mail arriving from now on is.
    h.receivedAtFor.set("e2", new Date(now - 1_800_000));
    h.receivedAtFor.set("e3", new Date(now + 1_000));
    h.pages = [{ created: ["e2", "e3"], newState: "s-3" }];
    h.inInbox.add("e2").add("e3");
    await expect(run()).resolves.toMatchObject({ copied: 3 });
    expect(h.copies.baselineOf(SHARED, bruno.userId)!.getTime()).toBeGreaterThanOrEqual(now);
    expect(copyCalls(h).filter((c) => c.by === bruno.email).map((c) => c.emailId)).toEqual(["e3"]);
  });
});

describe("runDeliveryCycle — delivery (GH #313)", () => {
  beforeEach(() => {
    h.copies.seedCursor(SHARED, "s-1");
    // Both members were baselined by an earlier cycle, so this one delivers to
    // them. A member's FIRST cycle only baselines them — see the block below.
    h.copies.seedMembers(SHARED, [ana.userId, bruno.userId]);
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
      unresolved: 0,
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

  // GH #313: the ledger row was written only after a confirmed Email/copy, so
  // between the provider making the copy and the row landing there was a
  // window in which a crash — or a transient database error, which was counted
  // as a failed copy — replayed the very same copy on the next cycle. The row
  // is claimed as `pending` first, so the ambiguous case is at-most-once.
  it("claims the ledger row before the copy and confirms it after", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    await run([ana]);
    // The claim precedes the Email/copy, not just the confirmation.
    expect(h.events).toEqual([
      `ledger:begin:${ana.userId}:e1`,
      `jmap:Email/copy:${ana.email}:e1`,
      `ledger:copied:${ana.userId}:e1`,
    ]);
  });

  it("leaves the row pending, and never re-copies it, when confirming the copy fails", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    h.copies.failMarkCopiedOnce();

    // The copy DID happen, so it counts as copied and the cycle carries on.
    await expect(run([ana])).resolves.toMatchObject({ copied: 1, failed: 0 });
    expect(h.logs.some((l) => l.level === "error" && l.msg.includes("ledger"))).toBe(true);
    expect(h.copies.states.get(`${ana.userId}|${SHARED}|e1`)).toBe("pending");

    // The next cycle finds the pending row: it counts it as unresolved and
    // does NOT copy it again. The manual button is the recovery.
    h.pages = [{ created: ["e1"], newState: "s-3" }];
    const before = copyCalls(h).length;
    await expect(run([ana])).resolves.toMatchObject({ copied: 0, unresolved: 1, skipped: 0 });
    expect(copyCalls(h)).toHaveLength(before);
    expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("unresolved"))).toBe(true);
  });

  it("counts an unresolved row once per member and reports it to the metric", async () => {
    const results: string[] = [];
    h.deps.onCopyResult = (result) => results.push(result);
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    await h.copies.repo.beginCopy(ana.userId, SHARED, "e1");

    await expect(run()).resolves.toMatchObject({ copied: 1, unresolved: 1 });
    expect(results.filter((r) => r === "unresolved")).toHaveLength(1);
    expect(copyCalls(h).map((c) => c.by)).toEqual([bruno.email]);
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
      // `keywords` rides along with the classification read, so no copy needs
      // a read of its own to preserve the source's flags; `messageId` is what
      // lets a retry ask whether the copy was already made; `receivedAt` is
      // what each member's baseline is compared against.
      properties: ["mailboxIds", "keywords", "messageId", "receivedAt"],
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
    // Recorded as failed with its reason, not just logged: the cursor moves on
    // and this row is what the next cycle's retry pass picks up.
    expect(h.copies.states.get(`${ana.userId}|${SHARED}|e1`)).toBe("failed");
    expect(h.copies.attempts.get(`${ana.userId}|${SHARED}|e1`)).toBe(1);
    expect(h.copies.errors.get(`${ana.userId}|${SHARED}|e1`)).toBe("copy_failed");
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

  // GH #313: a transient failure — the provider briefly refusing, a dropped
  // connection — used to cost the member that message for good, because the
  // cursor advanced past the page that carried it and nothing remembered the
  // attempt. Every cycle now drains a bounded batch of failed rows first.
  it("retries a copy that failed on an earlier cycle, before it looks at new pages", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    h.throwCopyFor.add(ana.email);
    await expect(run([ana])).resolves.toMatchObject({ copied: 0, failed: 1 });
    expect(h.copies.states.get(`${ana.userId}|${SHARED}|e1`)).toBe("failed");

    // Next cycle: the provider is healthy again. The retry runs before the new
    // page, and the message that was nearly lost is delivered.
    h.throwCopyFor.clear();
    h.events.length = 0;
    h.pages = [{ created: ["e2"], newState: "s-3" }];
    h.inInbox.add("e2");
    await expect(run([ana])).resolves.toMatchObject({ copied: 2, failed: 0 });
    expect(copyCalls(h).slice(-2).map((c) => c.emailId)).toEqual(["e1", "e2"]);
    expect(h.copies.states.get(`${ana.userId}|${SHARED}|e1`)).toBe("copied");
    expect(h.copies.states.get(`${ana.userId}|${SHARED}|e2`)).toBe("copied");
  });

  // GH #313: an Email/copy whose response was lost after the provider had
  // already committed it was recorded `failed` and retried — and the retry
  // delivered the message a second time. The claim now carries the source's
  // Message-ID, and the retry pass looks for that message in the member's own
  // inbox before copying anything.
  // GH #313: JMAP `messageId` values come WITHOUT angle brackets (RFC 8621
  // §4.1.3 `asMessageIds`), while a `header` filter compares against the raw
  // header value, which HAS them. The bare id was being queried against the
  // bracketed header, so the verification never found the copy it was
  // looking for and every lost-response retry delivered a duplicate anyway.
  it("records the source Message-ID bare, as the provider returns it", async () => {
    h.pages = [{ created: ["e1", "e2"], newState: "s-2" }];
    h.inInbox.add("e1").add("e2");
    h.messageIdFor.set("e1", ["abc@shared.test"]);
    // Defensive: a provider that returns the raw form is normalised too.
    h.messageIdFor.set("e2", ["<def@shared.test>"]);

    await run([ana]);
    expect(h.copies.messageIds.get(`${ana.userId}|${SHARED}|e1`)).toBe("abc@shared.test");
    expect(h.copies.messageIds.get(`${ana.userId}|${SHARED}|e2`)).toBe("def@shared.test");
  });

  // GH #313: `messageId` is a degradable property, and the client's latch is
  // per process. Once any conversation view had tripped it, the page read was
  // silently stripped of `messageId` too: every claim stored null and the
  // retry verification was disabled with nothing in the log. The page read
  // now keeps out of the shared latch, so an absent value means the PROVIDER
  // does not return it — and that is said once per cycle.
  it("reads the page outside the shared degradation latch", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");

    await run([ana]);
    const pageRead = h.requests.find(({ calls }) =>
      calls.some(([name, params]) => name === "Email/get" && Array.isArray(params.ids) && params.ids.length > 0),
    )!;
    expect(pageRead.options).toEqual({ degradation: "isolated" });
    // The copy and the personal-inbox lookup are ordinary shared requests.
    const others = h.requests.filter((request) => request !== pageRead);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((request) => request.options === undefined)).toBe(true);
  });

  it("warns once per cycle, and records no Message-ID, when the provider does not return messageId", async () => {
    h.omitMessageId = true;
    h.pages = [
      { created: ["e1"], newState: "s-2", hasMoreChanges: true },
      { created: ["e2"], newState: "s-3" },
    ];
    h.inInbox.add("e1").add("e2");

    await expect(run([ana])).resolves.toMatchObject({ copied: 2, pages: 2 });
    expect(h.copies.messageIds.get(`${ana.userId}|${SHARED}|e1`)).toBeNull();
    expect(h.copies.messageIds.get(`${ana.userId}|${SHARED}|e2`)).toBeNull();
    const warnings = h.logs.filter((l) => l.level === "warn" && l.msg.includes("messageId"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields).toMatchObject({ sharedAccountId: SHARED });

    // A source that HAS no Message-ID header (null, not absent) is not the
    // provider's fault and warns nothing.
    h.omitMessageId = false;
    h.logs.length = 0;
    h.messageIdFor.set("e3", null);
    h.pages = [{ created: ["e3"], newState: "s-4" }];
    h.inInbox.add("e3");
    await run([ana]);
    expect(h.copies.messageIds.get(`${ana.userId}|${SHARED}|e3`)).toBeNull();
    expect(h.logs.filter((l) => l.level === "warn" && l.msg.includes("messageId"))).toEqual([]);
  });

  it("marks a retry copied, without copying, when the member's inbox already holds it", async () => {
    h.copies.seedFailed(ana.userId, SHARED, "e1", 1, "lost@shared.test");
    h.personalCopies.add(`${ana.email}|<lost@shared.test>`);
    h.pages = [{ created: [], newState: "s-2" }];

    await expect(run([ana])).resolves.toMatchObject({ copied: 0, failed: 0, skipped: 1 });
    expect(copyCalls(h)).toEqual([]);
    expect(h.copies.states.get(`${ana.userId}|${SHARED}|e1`)).toBe("copied");
    // The query carries the header's raw form: the bare id wrapped in `<>`.
    expect(h.verifications).toEqual([
      {
        by: ana.email,
        messageId: "<lost@shared.test>",
        inMailbox: `inbox-personal-${ana.email}`,
      },
    ]);
  });

  it("brackets a stored id exactly once, even one recorded with its brackets", async () => {
    h.copies.seedFailed(ana.userId, SHARED, "e1", 1, "<legacy@shared.test>");
    h.personalCopies.add(`${ana.email}|<legacy@shared.test>`);
    h.pages = [{ created: [], newState: "s-2" }];

    await expect(run([ana])).resolves.toMatchObject({ skipped: 1 });
    expect(h.verifications.map((v) => v.messageId)).toEqual(["<legacy@shared.test>"]);
  });

  it("copies on retry when the verification finds nothing in the member's inbox", async () => {
    h.copies.seedFailed(ana.userId, SHARED, "e1", 1, "absent@shared.test");
    h.pages = [{ created: [], newState: "s-2" }];

    await expect(run([ana])).resolves.toMatchObject({ copied: 1 });
    expect(copyCalls(h).map((c) => c.emailId)).toEqual(["e1"]);
    expect(h.verifications).toHaveLength(1);
  });

  it("retries without verifying when the source carried no Message-ID", async () => {
    h.copies.seedFailed(ana.userId, SHARED, "e1", 1, null);
    h.pages = [{ created: [], newState: "s-2" }];

    await expect(run([ana])).resolves.toMatchObject({ copied: 1 });
    expect(h.verifications).toEqual([]);
    expect(copyCalls(h).map((c) => c.emailId)).toEqual(["e1"]);
  });

  // GH #313: an unanswerable verification used to leave the `failed` row
  // exactly as it was — no attempt spent, `updated_at` untouched — so a copy
  // whose verification never answers was immortal: it sat at the head of the
  // oldest-first retry batch on every cycle, and with enough of them the
  // batch never reached anybody else's copy.
  it("spends an attempt, without copying, when the verification cannot be answered", async () => {
    h.copies.seedFailed(ana.userId, SHARED, "e1", 1, "unknown@shared.test");
    h.queryThrowsFor.add(ana.email);
    h.pages = [{ created: [], newState: "s-2" }];

    // Copying blind is the one thing that cannot be undone, so no copy is
    // made — but the attempt IS counted, so the row ages out like any other.
    await expect(run([ana])).resolves.toMatchObject({ copied: 0, failed: 1, skipped: 0 });
    expect(copyCalls(h)).toEqual([]);
    expect(h.copies.states.get(`${ana.userId}|${SHARED}|e1`)).toBe("failed");
    expect(h.copies.attempts.get(`${ana.userId}|${SHARED}|e1`)).toBe(2);
    expect(h.copies.errors.get(`${ana.userId}|${SHARED}|e1`)).toMatch(/^verification unavailable: /);
    expect(h.logs.some((l) => l.level === "warn" && l.msg.includes("verif"))).toBe(true);
  });

  // GH #313: `alreadyCopied` answered "absent" when the member's personal
  // inbox could not be resolved — against its own contract — so a cached
  // lookup failure made every retry for that member copy WITHOUT verification.
  // An inbox that cannot be named is a question that cannot be asked.
  it("holds off, spending an attempt, when the member's inbox cannot be resolved for the verification", async () => {
    h.copies.seedFailed(ana.userId, SHARED, "e1", 1, "lost@shared.test");
    h.noPersonalInboxFor.add(ana.email);
    h.pages = [{ created: [], newState: "s-2" }];

    await expect(run([ana])).resolves.toMatchObject({ copied: 0, failed: 1, skipped: 0 });
    expect(copyCalls(h)).toEqual([]);
    expect(h.verifications).toEqual([]);
    expect(h.copies.attempts.get(`${ana.userId}|${SHARED}|e1`)).toBe(2);
    expect(h.copies.errors.get(`${ana.userId}|${SHARED}|e1`)).toBe(
      "verification unavailable: personal inbox unresolved",
    );
  });

  it("ages out a copy whose verification never answers, so it stops holding the head of the batch", async () => {
    h.copies.seedFailed(ana.userId, SHARED, "e-stuck", 0, "stuck@shared.test");
    h.queryThrowsForMessageId.add("<stuck@shared.test>");

    for (let cycle = 0; cycle < DELIVERY_RETRY_MAX_ATTEMPTS; cycle += 1) {
      h.pages = [{ created: [], newState: `s-${cycle + 2}` }];
      await expect(run([ana])).resolves.toMatchObject({ copied: 0, failed: 1 });
    }
    expect(h.verifications.filter((v) => v.messageId === "<stuck@shared.test>")).toHaveLength(
      DELIVERY_RETRY_MAX_ATTEMPTS,
    );
    expect(h.copies.attempts.get(`${ana.userId}|${SHARED}|e-stuck`)).toBe(DELIVERY_RETRY_MAX_ATTEMPTS);

    // Out of attempts: the row is no longer retryable, and a copy that failed
    // after it is reached and delivered instead of waiting behind it.
    h.copies.seedFailed(ana.userId, SHARED, "e-live", 1, "live@shared.test");
    h.verifications.length = 0;
    h.pages = [{ created: [], newState: "s-99" }];
    await expect(run([ana])).resolves.toMatchObject({ copied: 1, failed: 0 });
    expect(h.verifications.map((v) => v.messageId)).toEqual(["<live@shared.test>"]);
    expect(copyCalls(h).map((c) => c.emailId)).toEqual(["e-live"]);
  });

  it("stops retrying a copy that has used its attempts, and leaves the row as the record", async () => {
    h.copies.seedFailed(ana.userId, SHARED, "e1", DELIVERY_RETRY_MAX_ATTEMPTS);
    h.pages = [{ created: [], newState: "s-2" }];

    await expect(run([ana])).resolves.toMatchObject({ copied: 0, failed: 0 });
    expect(copyCalls(h)).toEqual([]);
    expect(h.copies.states.get(`${ana.userId}|${SHARED}|e1`)).toBe("failed");
  });

  // GH #313: the cycle used to prune against its own member list — the
  // DELIVERABLE members — so a member deactivated for an afternoon, or
  // momentarily without a credential, lost their owed rows inside the first
  // cycle that ran without them. Pruning is the worker's, against what the
  // preference says; a cycle neither delivers to nor forgets such a member.
  it("counts a retry that fails again, and leaves a member absent from this cycle exactly as they were", async () => {
    h.copies.seedFailed(ana.userId, SHARED, "e1", 1);
    h.copies.seedFailed(bruno.userId, SHARED, "e9", 1);
    h.refuseCopyFor.add(ana.email);
    h.pages = [{ created: [], newState: "s-2" }];

    await expect(run([ana])).resolves.toMatchObject({ copied: 0, failed: 1 });
    expect(copyCalls(h).map((c) => c.emailId)).toEqual(["e1"]);
    expect(h.copies.attempts.get(`${ana.userId}|${SHARED}|e1`)).toBe(2);
    // Bruno is not in this cycle's list — deactivated right now — so nothing
    // is delivered to him, and his baseline and his owed row are kept for
    // when he is back.
    expect(h.copies.states.get(`${bruno.userId}|${SHARED}|e9`)).toBe("failed");
    expect(h.copies.attempts.get(`${bruno.userId}|${SHARED}|e9`)).toBe(1);
    expect(h.copies.baselined(SHARED)).toContain(bruno.userId);

    // Reactivated: the next cycle resumes his owed copy.
    h.pages = [{ created: [], newState: "s-3" }];
    await expect(run()).resolves.toMatchObject({ copied: 1 });
    expect(copyCalls(h).at(-1)).toMatchObject({ by: bruno.email, emailId: "e9" });
  });

  // GH #313: the batch is the oldest failed rows of the ACCOUNT, capped at
  // 100. Asking for it without naming this cycle's members let the rows of
  // members who had left fill it and starve the members the cycle can
  // actually serve.
  it("asks for the retry batch of this cycle's members only", async () => {
    h.pages = [{ created: [], newState: "s-2" }];

    await run([ana]);
    expect(h.copies.retryQueries).toEqual([[ana.userId]]);
  });

  it("spends an attempt instead of retrying a copy that predates the member's baseline", async () => {
    // The same timestamp rule as the page: a failed row for a message the
    // shared mailbox received before this member's opt-in is not delivered,
    // and it ages out like any other row rather than sitting at the head of
    // the batch for ever.
    h.copies.seedFailed(bruno.userId, SHARED, "e9", 1, "old@shared.test", new Date(Date.now() - 3_600_000));
    h.pages = [{ created: [], newState: "s-2" }];

    await expect(run()).resolves.toMatchObject({ copied: 0, failed: 1 });
    expect(copyCalls(h)).toEqual([]);
    expect(h.verifications).toEqual([]);
    expect(h.copies.attempts.get(`${bruno.userId}|${SHARED}|e9`)).toBe(2);
    expect(h.copies.errors.get(`${bruno.userId}|${SHARED}|e9`)).toMatch(/opt-in|baseline/);
  });

  // GH #313: every copy used to cost its own lookup batch — a Mailbox/query
  // for the member's inbox and an Email/get for the source's keywords — so a
  // page of 100 messages for 5 members was 500 extra round trips for two
  // answers the cycle already had.
  it("issues one lookup per member per cycle, not one per message", async () => {
    h.pages = [{ created: ["e1", "e2", "e3"], newState: "s-2" }];
    h.inInbox.add("e1").add("e2").add("e3");

    await expect(run([ana])).resolves.toMatchObject({ copied: 3 });

    const calls = h.requests.flatMap(({ calls: batch }) => batch);
    const personalInboxQueries = calls.filter(
      ([name, params]) =>
        name === "Mailbox/query" && (params as { accountId: string }).accountId !== SHARED,
    );
    expect(personalInboxQueries).toHaveLength(1);
    expect(calls.filter(([name]) => name === "Email/copy")).toHaveLength(3);
    // The page's own Email/get carries the keywords, so no per-message read.
    const shared = calls.filter(
      ([name, params]) =>
        name === "Email/get" && (params as { accountId: string }).accountId === SHARED,
    );
    expect(shared).toHaveLength(1);
    expect((shared[0]![1] as { properties: string[] }).properties).toEqual([
      "mailboxIds",
      "keywords",
      "messageId",
      "receivedAt",
    ]);
  });

  it("carries the source keywords from the page read into each copy", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    h.keywordsFor.set("e1", { $flagged: true });

    await run([ana]);
    const copyParams = h.requests
      .flatMap(({ calls }) => calls)
      .find(([name]) => name === "Email/copy")![1] as {
      create: { c: { keywords: Record<string, boolean> } };
    };
    expect(copyParams.create.c.keywords).toEqual({ $flagged: true });
  });

  it("falls back to the lookup path for a member whose inbox cannot be resolved", async () => {
    h.pages = [{ created: ["e1"], newState: "s-2" }];
    h.inInbox.add("e1");
    h.noPersonalInboxFor.add(ana.email);

    // Not silently skipped: it is a failed copy, exactly as before.
    await expect(run([ana])).resolves.toMatchObject({ copied: 0, failed: 1 });
    expect(h.logs.some((l) => l.level === "warn" && l.fields.reason === "mailbox_roles_missing")).toBe(
      true,
    );
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
