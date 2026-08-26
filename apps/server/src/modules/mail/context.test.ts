import { describe, expect, it } from "vitest";
import type { JmapClient, JmapSession } from "../../infra/jmap/client";
import type { MailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { evictMailSession, getMailSession } from "./context";

// GH #313: the JMAP session lookup requireMail always did inline, exposed as a
// function so background work (the shared-mailbox copy worker) can reach a
// member's session with no request in flight. Same cache, same misses.

const session: JmapSession = {
  apiUrl: "https://mail.test/jmap/",
  accountId: "acc-personal",
  eventSourceUrl: "https://mail.test/es",
  uploadUrl: "https://mail.test/upload/{accountId}/",
  downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
  accounts: [{ id: "acc-personal", name: "Me", isPersonal: true }],
};

function stubJmap(): { jmap: JmapClient; sessionCalls: number } {
  const counter = { sessionCalls: 0 };
  const jmap: JmapClient = {
    getSession: async () => {
      counter.sessionCalls += 1;
      return session;
    },
    request: async () => [],
    uploadBlob: async () => "blob-id",
  };
  return {
    jmap,
    get sessionCalls() {
      return counter.sessionCalls;
    },
  };
}

function credentials(password: string | null): MailCredentialsRepo {
  return {
    get: async () => password,
    set: async () => {},
    exists: async () => password !== null,
    existsForUsers: async () => new Set(),
    count: async () => 0,
  };
}

function user() {
  return { userId: crypto.randomUUID(), email: "member@noxvytop.com" };
}

describe("getMailSession (GH #313)", () => {
  it("reports mail_not_configured when no JMAP client is wired", async () => {
    const result = await getMailSession({ jmap: null, mailCredentials: credentials("pw") }, user());
    expect(result).toEqual({ ok: false, reason: "mail_not_configured" });
  });

  it("reports mail_credentials_missing when the user has no stored mailbox credential", async () => {
    const { jmap, sessionCalls } = stubJmap();
    const result = await getMailSession({ jmap, mailCredentials: credentials(null) }, user());
    expect(result).toEqual({ ok: false, reason: "mail_credentials_missing" });
    expect(sessionCalls).toBe(0);
  });

  it("resolves the member's auth and session from the stored credential", async () => {
    const stub = stubJmap();
    const member = user();
    const result = await getMailSession(
      { jmap: stub.jmap, mailCredentials: credentials("mailbox-pw") },
      member,
    );
    expect(result).toEqual({
      ok: true,
      auth: { email: member.email, password: "mailbox-pw" },
      session,
    });
  });

  it("serves a second lookup from the cache instead of asking the provider again", async () => {
    const stub = stubJmap();
    const deps = { jmap: stub.jmap, mailCredentials: credentials("pw") };
    const member = user();
    await getMailSession(deps, member);
    await getMailSession(deps, member);
    expect(stub.sessionCalls).toBe(1);
  });

  it("asks the provider again once the user's session has been evicted", async () => {
    const stub = stubJmap();
    const deps = { jmap: stub.jmap, mailCredentials: credentials("pw") };
    const member = user();
    await getMailSession(deps, member);
    evictMailSession(member.userId);
    await getMailSession(deps, member);
    expect(stub.sessionCalls).toBe(2);
  });
});
