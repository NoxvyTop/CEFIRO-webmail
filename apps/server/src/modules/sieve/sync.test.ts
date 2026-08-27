import { describe, expect, it } from "vitest";
import type { FilterRule } from "@webmail/shared";
import type { JmapClient, JmapMethodCall, JmapSession } from "../../infra/jmap/client";
import {
  DEFAULT_TRASH_FOLDER,
  MANAGED_SCRIPT_NAME,
  SIEVE_CAPABILITY,
  resolveTrashFolder,
  supportsSieve,
  syncSieveScript,
  uploadAndValidateScript,
} from "./sync";

const auth = { email: "u@noxvytop.com", password: "pw" };
const session: JmapSession = {
  apiUrl: "http://stalwart/jmap/api",
  accountId: "acc1",
  eventSourceUrl: "",
  uploadUrl: "http://stalwart/upload/{accountId}/",
  downloadUrl: "",
};

const sampleRule: FilterRule = {
  id: "r1",
  position: 0,
  name: "trash spam",
  matchType: "all",
  conditions: [{ field: "subject", op: "contains", value: "lottery" }],
  actions: [{ type: "delete" }],
  enabled: true,
};

type Recorded = { method: string; args: Record<string, unknown>; extraUsing: string[] };

function fakeJmap(options: {
  existingScripts?: { id: string; name: string }[];
  validateError?: unknown;
  setResponse?: Record<string, unknown>;
  mailboxes?: { name: string; role?: string | null }[];
  /**
   * Override which script the provider considers ACTIVE. Defaults to the
   * existing managed script, because this system always activates it (every
   * create/update below carries `onSuccessActivateScript`).
   */
  activeScriptId?: string | null;
  /**
   * Simulate a provider that ignores `onSuccessDeactivateScript` — used to
   * prove a destroy that follows a failed deactivation is still surfaced as a
   * failure rather than a silent success (GH #266).
   */
  deactivatable?: boolean;
}) {
  const calls: Recorded[] = [];
  const uploads: string[] = [];
  const existingScripts = options.existingScripts ?? [];
  // The fake tracks the active script so it can enforce RFC 9661 honestly: a
  // destroy aimed at the active script is refused with a `sieveIsActive`
  // SetError, exactly as Stalwart does (GH #266). Without this the old
  // single-call destroy path passed here while 502ing against a live server.
  let activeScriptId: string | null =
    options.activeScriptId !== undefined
      ? options.activeScriptId
      : (existingScripts.find((s) => s.name === MANAGED_SCRIPT_NAME)?.id ?? null);
  const client = {
    async getSession() {
      return session;
    },
    async request(
      _auth: unknown,
      _session: unknown,
      methodCalls: JmapMethodCall[],
      extraUsing: string[] = [],
    ) {
      const [method, args] = methodCalls[0]!;
      calls.push({ method, args, extraUsing });
      if (method === "Mailbox/get") {
        return [
          ["Mailbox/get", { list: options.mailboxes ?? [{ name: "Papelera", role: "trash" }] }, "0"],
        ];
      }
      if (method === "SieveScript/get") {
        return [["SieveScript/get", { list: existingScripts }, "0"]];
      }
      if (method === "SieveScript/validate") {
        return [["SieveScript/validate", { error: options.validateError ?? null }, "0"]];
      }
      if (method === "SieveScript/set") {
        const setArgs = args as {
          destroy?: string[];
          onSuccessActivateScript?: string | null;
          onSuccessDeactivateScript?: boolean;
        };
        // RFC 9661: onSuccess(De)activate are applied AFTER create/update/
        // destroy, so a destroy of the still-active script is refused with a
        // `sieveIsActive` SetError whatever activation argument it carries.
        const blockedId = (setArgs.destroy ?? []).find((id) => id === activeScriptId);
        if (blockedId !== undefined) {
          return [
            ["SieveScript/set", { notDestroyed: { [blockedId]: { type: "sieveIsActive" } } }, "0"],
          ];
        }
        // A canned response drives the notCreated failure path, once the
        // active-destroy rule above has had its say.
        if (options.setResponse) {
          return [["SieveScript/set", options.setResponse, "0"]];
        }
        // Apply the activation semantics a real server would: deactivate first
        // (how the empty-rule path frees the managed script), then activate.
        if (setArgs.onSuccessDeactivateScript === true && options.deactivatable !== false) {
          activeScriptId = null;
        }
        if (typeof setArgs.onSuccessActivateScript === "string") {
          activeScriptId = setArgs.onSuccessActivateScript;
        }
        return [["SieveScript/set", {}, "0"]];
      }
      return [[method, {}, "0"]];
    },
    async uploadBlob(_auth: unknown, _session: unknown, content: string) {
      uploads.push(content);
      return "blob1";
    },
  } as unknown as JmapClient;
  return { client, calls, uploads };
}

describe("syncSieveScript", () => {
  it("uploads, validates, then creates and activates a new script", async () => {
    const { client, calls, uploads } = fakeJmap({});
    await syncSieveScript({ jmap: client, auth, session, rules: [sampleRule], vacation: null });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain('fileinto "Papelera";');
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["Mailbox/get", "SieveScript/get", "SieveScript/validate", "SieveScript/set"]);
    const set = calls.at(-1)!;
    expect(set.extraUsing).toEqual([SIEVE_CAPABILITY]);
    expect(set.args).toMatchObject({
      create: { webmailScript: { name: MANAGED_SCRIPT_NAME, blobId: "blob1" } },
      onSuccessActivateScript: "#webmailScript",
    });
  });

  it("updates the existing managed script", async () => {
    const { client, calls } = fakeJmap({
      existingScripts: [{ id: "s9", name: MANAGED_SCRIPT_NAME }],
    });
    await syncSieveScript({ jmap: client, auth, session, rules: [sampleRule], vacation: null });
    const set = calls.at(-1)!;
    expect(set.method).toBe("SieveScript/set");
    expect(set.args).toMatchObject({
      update: { s9: { blobId: "blob1" } },
      onSuccessActivateScript: "s9",
    });
  });

  it("deactivates the managed script before destroying it when nothing remains", async () => {
    const { client, calls, uploads } = fakeJmap({
      existingScripts: [{ id: "s9", name: MANAGED_SCRIPT_NAME }],
    });
    await syncSieveScript({ jmap: client, auth, session, rules: [], vacation: null });
    expect(uploads).toHaveLength(0);
    // RFC 9661: the active script can only be destroyed after a SEPARATE
    // deactivation (GH #266). The fake refuses a same-call destroy with
    // `sieveIsActive`, so this passing proves the two-call shape.
    const setCalls = calls.filter((c) => c.method === "SieveScript/set");
    expect(setCalls).toHaveLength(2);
    expect(setCalls[0]!.args).toMatchObject({ onSuccessDeactivateScript: true });
    expect(setCalls[0]!.args).not.toHaveProperty("destroy");
    expect(setCalls[1]!.args).toMatchObject({ destroy: ["s9"] });
  });

  it("surfaces sieve_sync_failed when the provider refuses to deactivate the active script", async () => {
    // A provider that ignores the deactivation leaves the managed script active,
    // so the following destroy is refused with `sieveIsActive` and must be
    // reported as a failure, never swallowed as a silent success (GH #266).
    const { client } = fakeJmap({
      existingScripts: [{ id: "s9", name: MANAGED_SCRIPT_NAME }],
      deactivatable: false,
    });
    await expect(
      syncSieveScript({ jmap: client, auth, session, rules: [], vacation: null }),
    ).rejects.toMatchObject({ code: "sieve_sync_failed" });
  });

  it("does nothing when nothing remains and no managed script exists", async () => {
    const { client, calls } = fakeJmap({});
    await syncSieveScript({ jmap: client, auth, session, rules: [], vacation: null });
    expect(calls.map((c) => c.method)).toEqual(["Mailbox/get", "SieveScript/get"]);
  });

  it("throws sieve_invalid when validate rejects", async () => {
    const { client } = fakeJmap({ validateError: { type: "invalidScript" } });
    await expect(
      syncSieveScript({ jmap: client, auth, session, rules: [sampleRule], vacation: null }),
    ).rejects.toMatchObject({ code: "sieve_invalid" });
  });

  it("throws sieve_sync_failed when set is refused", async () => {
    const { client } = fakeJmap({
      setResponse: { notCreated: { webmailScript: { type: "forbidden" } } },
    });
    await expect(
      syncSieveScript({ jmap: client, auth, session, rules: [sampleRule], vacation: null }),
    ).rejects.toMatchObject({ code: "sieve_sync_failed" });
  });
});

// GH #23: in advanced mode a hand-written script owns the account, and the
// generator is not consulted at all.
describe("syncSieveScript in advanced mode", () => {
  const handWritten = 'require ["reject"];\nreject "closed";\n';

  it("pushes the hand-written script verbatim, generating nothing", async () => {
    const { client, calls, uploads } = fakeJmap({});
    await syncSieveScript({
      jmap: client,
      auth,
      session,
      rules: [sampleRule],
      vacation: null,
      raw: { mode: "raw", script: handWritten, updatedAt: "2026-07-01T10:00:00.000Z" },
    });

    expect(uploads).toEqual([handWritten]);
    // No Mailbox/get: nothing needs the trash folder's name, so raw mode costs
    // one JMAP round-trip LESS than the generated path rather than one more.
    expect(calls.map((c) => c.method)).toEqual([
      "SieveScript/get",
      "SieveScript/validate",
      "SieveScript/set",
    ]);
  });

  it("regenerates from the rules again once ownership is handed back", async () => {
    const { client, uploads } = fakeJmap({});
    await syncSieveScript({
      jmap: client,
      auth,
      session,
      rules: [sampleRule],
      vacation: null,
      raw: { mode: "rules", script: handWritten, updatedAt: "2026-07-01T10:00:00.000Z" },
    });

    // The stored script is still there and is simply not the active one.
    expect(uploads[0]).toContain("# rule: trash spam");
    expect(uploads[0]).not.toContain("reject");
  });
});

describe("uploadAndValidateScript", () => {
  it("returns the blob id the provider accepted", async () => {
    const { client, calls } = fakeJmap({});
    const blobId = await uploadAndValidateScript({ jmap: client, auth, session, script: "stop;\n" });
    expect(blobId).toBe("blob1");
    expect(calls.map((c) => c.method)).toEqual(["SieveScript/validate"]);
  });

  it("throws sieve_invalid when the provider's parser refuses it", async () => {
    const { client } = fakeJmap({ validateError: { type: "invalidScript" } });
    await expect(
      uploadAndValidateScript({ jmap: client, auth, session, script: "if header {" }),
    ).rejects.toMatchObject({ code: "sieve_invalid" });
  });
});

describe("resolveTrashFolder", () => {
  it("uses the provider's own name for the trash mailbox", async () => {
    const { client } = fakeJmap({});
    expect(await resolveTrashFolder({ jmap: client, auth, session })).toBe("Papelera");
  });

  it("falls back to the default when the provider lists no trash mailbox", async () => {
    const { client } = fakeJmap({ mailboxes: [{ name: "Inbox", role: "inbox" }] });
    expect(await resolveTrashFolder({ jmap: client, auth, session })).toBe(DEFAULT_TRASH_FOLDER);
  });
});

// GH #36: `urn:ietf:params:jmap:sieve` is an extension, so whether filters and
// vacation can work at all is a property of the account's provider — a fact the
// JMAP session already states and this server used to ignore.
describe("supportsSieve", () => {
  it("is true when the session advertises the Sieve capability", () => {
    expect(
      supportsSieve({ ...session, capabilities: ["urn:ietf:params:jmap:mail", SIEVE_CAPABILITY] }),
    ).toBe(true);
  });

  it("is false when the session advertises capabilities and Sieve is not among them", () => {
    expect(supportsSieve({ ...session, capabilities: ["urn:ietf:params:jmap:mail"] })).toBe(false);
  });

  it("is false for a provider that advertises nothing at all", () => {
    // An empty list is a real answer ("no extensions"), not a missing one.
    expect(supportsSieve({ ...session, capabilities: [] })).toBe(false);
  });

  it("is true when the capability list is unknown", () => {
    // Only a hand-built session gets here (getSession always sets the field).
    // Unknown stays optimistic: a wrong yes costs the error that already
    // existed, a wrong no would hide a working feature.
    expect(supportsSieve(session)).toBe(true);
  });
});
