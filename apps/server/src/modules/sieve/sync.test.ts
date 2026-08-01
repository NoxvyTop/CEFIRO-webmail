import { describe, expect, it } from "vitest";
import type { FilterRule } from "@webmail/shared";
import type { JmapClient, JmapMethodCall, JmapSession } from "../../infra/jmap/client";
import { MANAGED_SCRIPT_NAME, SIEVE_CAPABILITY, supportsSieve, syncSieveScript } from "./sync";

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
}) {
  const calls: Recorded[] = [];
  const uploads: string[] = [];
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
        return [["Mailbox/get", { list: [{ name: "Papelera", role: "trash" }] }, "0"]];
      }
      if (method === "SieveScript/get") {
        return [["SieveScript/get", { list: options.existingScripts ?? [] }, "0"]];
      }
      if (method === "SieveScript/validate") {
        return [["SieveScript/validate", { error: options.validateError ?? null }, "0"]];
      }
      if (method === "SieveScript/set") {
        return [["SieveScript/set", options.setResponse ?? {}, "0"]];
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

  it("destroys the managed script when nothing remains", async () => {
    const { client, calls, uploads } = fakeJmap({
      existingScripts: [{ id: "s9", name: MANAGED_SCRIPT_NAME }],
    });
    await syncSieveScript({ jmap: client, auth, session, rules: [], vacation: null });
    expect(uploads).toHaveLength(0);
    const set = calls.at(-1)!;
    expect(set.method).toBe("SieveScript/set");
    expect(set.args).toMatchObject({ destroy: ["s9"], onSuccessActivateScript: null });
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
