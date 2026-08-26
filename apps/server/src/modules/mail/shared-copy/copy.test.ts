import { beforeEach, describe, expect, it } from "vitest";
import type {
  JmapClient,
  JmapMethodCall,
  JmapMethodResponse,
  JmapSession,
} from "../../../infra/jmap/client";
import { copyEmailToPersonalInbox } from "./copy";

// GH #313: the G-2 copy, lifted out of the route so the background delivery
// can issue the exact same two batches with a member's credential. These pin
// the batch shapes and the positive-confirmation rule the route tests already
// pin at the HTTP level, so the function cannot drift from what the route did.

const session: JmapSession = {
  apiUrl: "https://mail.test/jmap/",
  accountId: "acc-personal",
  eventSourceUrl: "https://mail.test/es",
  uploadUrl: "https://mail.test/upload/{accountId}/",
  downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
  accounts: [
    { id: "acc-personal", name: "Me", isPersonal: true },
    { id: "acc-shared", name: "Ventas", isPersonal: false },
  ],
};
const auth = { email: "m@noxvytop.com", password: "pw" };

let requests: JmapMethodCall[][] = [];
let inboxQueryIds: string[] = ["mb-inbox-personal"];
let sourceEmailList: Array<{ id: string; keywords?: Record<string, boolean> }> = [
  { id: "e1", keywords: { $seen: true } },
];
let copyResponse: Record<string, unknown> = { created: { c: { id: "copy-1" } } };

const jmap: JmapClient = {
  getSession: async () => session,
  request: async (_auth, _session, methodCalls) => {
    requests.push(methodCalls);
    return methodCalls.map(([name, , callId]): JmapMethodResponse => {
      if (name === "Mailbox/query") return ["Mailbox/query", { ids: inboxQueryIds }, callId];
      if (name === "Email/get") return ["Email/get", { list: sourceEmailList }, callId];
      if (name === "Email/copy") return ["Email/copy", copyResponse, callId];
      throw new Error(`unexpected JMAP method call in test stub: ${name}`);
    });
  },
  uploadBlob: async () => "blob-id",
};

beforeEach(() => {
  requests = [];
  inboxQueryIds = ["mb-inbox-personal"];
  sourceEmailList = [{ id: "e1", keywords: { $seen: true } }];
  copyResponse = { created: { c: { id: "copy-1" } } };
});

function copy(fromAccountId = "acc-shared", emailId = "e1") {
  return copyEmailToPersonalInbox({ jmap, auth, session, fromAccountId, emailId });
}

function copyCall(): JmapMethodCall | undefined {
  return requests.flat().find(([name]) => name === "Email/copy");
}

describe("copyEmailToPersonalInbox (GH #313)", () => {
  it("copies from the shared account into the personal inbox and reports the created id", async () => {
    await expect(copy()).resolves.toEqual({ ok: true, createdId: "copy-1" });

    const params = copyCall()?.[1] as {
      fromAccountId: string;
      accountId: string;
      onSuccessDestroyOriginal: boolean;
      create: { c: { id: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> } };
    };
    expect(params.fromAccountId).toBe("acc-shared");
    expect(params.accountId).toBe("acc-personal");
    expect(params.onSuccessDestroyOriginal).toBe(false);
    expect(params.create.c).toEqual({
      id: "e1",
      mailboxIds: { "mb-inbox-personal": true },
      keywords: { $seen: true },
    });
  });

  it("issues the lookup and the copy as two separate batches, lookup first", async () => {
    await copy();
    // Two batches: request() fails a whole batch on any method error, and a
    // mutating call must never be retried alongside the reads.
    expect(requests).toHaveLength(2);
    const [lookup, mutation] = requests;
    expect(lookup!.map(([name]) => name)).toEqual(["Mailbox/query", "Email/get"]);
    expect(mutation!.map(([name]) => name)).toEqual(["Email/copy"]);

    const mailboxQuery = lookup!.find(([name]) => name === "Mailbox/query")![1] as {
      accountId: string;
      filter: { role: string };
    };
    expect(mailboxQuery.accountId).toBe("acc-personal");
    expect(mailboxQuery.filter.role).toBe("inbox");
    const emailGet = lookup!.find(([name]) => name === "Email/get")![1] as {
      accountId: string;
      ids: string[];
      properties: string[];
    };
    expect(emailGet.accountId).toBe("acc-shared");
    expect(emailGet.ids).toEqual(["e1"]);
    expect(emailGet.properties).toEqual(["keywords"]);
  });

  it("carries an empty keyword set when the source has none", async () => {
    sourceEmailList = [{ id: "e1" }];
    await expect(copy()).resolves.toEqual({ ok: true, createdId: "copy-1" });
    const params = copyCall()?.[1] as { create: { c: { keywords: Record<string, boolean> } } };
    expect(params.create.c.keywords).toEqual({});
  });

  it("refuses a same-account copy before touching JMAP", async () => {
    await expect(copy("acc-personal")).resolves.toEqual({ ok: false, reason: "invalid_account" });
    expect(requests).toHaveLength(0);
  });

  it("reports mailbox_roles_missing when the personal inbox cannot be resolved, without copying", async () => {
    inboxQueryIds = [];
    await expect(copy()).resolves.toEqual({ ok: false, reason: "mailbox_roles_missing" });
    expect(copyCall()).toBeUndefined();
  });

  it("reports not_found when the source is not in the shared account, without copying", async () => {
    sourceEmailList = [];
    await expect(copy()).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(copyCall()).toBeUndefined();
  });

  it("reports copy_failed on notCreated", async () => {
    copyResponse = { notCreated: { c: { type: "invalidArguments" } } };
    await expect(copy()).resolves.toEqual({ ok: false, reason: "copy_failed" });
  });

  it("reports copy_failed rather than success when neither created nor notCreated confirms", async () => {
    copyResponse = {};
    await expect(copy()).resolves.toEqual({ ok: false, reason: "copy_failed" });
  });

  // GH #313: the lookup batch answers two questions the delivery cycle already
  // knows — where this member's inbox is (once per cycle, not once per
  // message) and what the source's keywords are (already read to classify the
  // page). Handing them in turns two round trips per (member, message) into
  // one; the manual route, which knows neither, keeps the lookup path.
  describe("with the inbox and keywords already known", () => {
    it("issues the copy alone, with the given inbox and keywords", async () => {
      await expect(
        copyEmailToPersonalInbox({
          jmap,
          auth,
          session,
          fromAccountId: "acc-shared",
          emailId: "e1",
          personalInboxId: "mb-inbox-precomputed",
          keywords: { $flagged: true },
        }),
      ).resolves.toEqual({ ok: true, createdId: "copy-1" });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.map(([name]) => name)).toEqual(["Email/copy"]);
      const params = copyCall()?.[1] as { create: { c: Record<string, unknown> } };
      expect(params.create.c).toEqual({
        id: "e1",
        mailboxIds: { "mb-inbox-precomputed": true },
        keywords: { $flagged: true },
      });
    });

    it("still refuses a same-account copy", async () => {
      await expect(
        copyEmailToPersonalInbox({
          jmap,
          auth,
          session,
          fromAccountId: "acc-personal",
          emailId: "e1",
          personalInboxId: "mb-inbox-precomputed",
          keywords: {},
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid_account" });
      expect(requests).toHaveLength(0);
    });

    it("falls back to the lookup when only one of the two is known", async () => {
      await expect(
        copyEmailToPersonalInbox({
          jmap,
          auth,
          session,
          fromAccountId: "acc-shared",
          emailId: "e1",
          personalInboxId: "mb-inbox-precomputed",
        }),
      ).resolves.toEqual({ ok: true, createdId: "copy-1" });
      expect(requests).toHaveLength(2);
      const params = copyCall()?.[1] as { create: { c: { mailboxIds: Record<string, boolean> } } };
      expect(params.create.c.mailboxIds).toEqual({ "mb-inbox-personal": true });
    });
  });
});
