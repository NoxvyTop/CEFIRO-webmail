import { describe, expect, it, vi } from "vitest";
import { createJmapClient, type JmapSession } from "./jmap";

const auth = { email: "u@noxvytop.com", password: "mailbox-pw" };
const sessionBody = {
  apiUrl: "https://mail.test/jmap/",
  eventSourceUrl: "https://mail.test/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
  uploadUrl: "https://mail.test/jmap/upload/{accountId}/",
  downloadUrl: "https://mail.test/jmap/download/{accountId}/{blobId}/{name}?type={type}",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
};

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("jmap client", () => {
  it("fetches the session with basic auth and maps fields", async () => {
    const fetchFn = fetchReturning(sessionBody);
    const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });
    const session = await client.getSession(auth);
    expect(session.accountId).toBe("acc-1");
    expect(session.apiUrl).toBe("https://mail.test/jmap/");
    expect(session.uploadUrl).toBe("https://mail.test/jmap/upload/{accountId}/");
    expect(session.downloadUrl).toBe(
      "https://mail.test/jmap/download/{accountId}/{blobId}/{name}?type={type}",
    );
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe("https://mail.test/.well-known/jmap");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${btoa("u@noxvytop.com:mailbox-pw")}`,
    );
  });

  it("maps 401 to mail_auth_failed", async () => {
    const client = createJmapClient({
      baseUrl: "https://mail.test",
      fetchFn: fetchReturning({}, 401),
    });
    await expect(client.getSession(auth)).rejects.toMatchObject({
      code: "mail_auth_failed",
    });
  });

  it("posts method calls and returns methodResponses", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ methodResponses: [["Mailbox/get", { list: [] }, "0"]] }),
      ),
    ) as unknown as typeof fetch;
    const client = createJmapClient({ baseUrl: "https://mail.test", fetchFn });
    const session: JmapSession = {
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    };
    const responses = await client.request(auth, session, [
      ["Mailbox/get", { accountId: "acc-1" }, "0"],
    ]);
    expect(responses[0]?.[0]).toBe("Mailbox/get");
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.using).toContain("urn:ietf:params:jmap:mail");
    expect(body.using).toContain("urn:ietf:params:jmap:submission");
    expect(body.methodCalls[0][0]).toBe("Mailbox/get");
  });

  it("maps a jmap error response tuple to jmap_error", async () => {
    const client = createJmapClient({
      baseUrl: "https://mail.test",
      fetchFn: fetchReturning({
        methodResponses: [["error", { type: "serverFail" }, "0"]],
      }),
    });
    const session: JmapSession = {
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    };
    await expect(
      client.request(auth, session, [["Mailbox/get", {}, "0"]]),
    ).rejects.toMatchObject({ code: "jmap_error" });
  });
});
