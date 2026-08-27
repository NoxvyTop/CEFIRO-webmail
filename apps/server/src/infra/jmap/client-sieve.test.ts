import { describe, expect, it } from "vitest";
import { createJmapClient, type JmapSession } from "./client";

const auth = { email: "u@noxvytop.com", password: "pw" };
const session: JmapSession = {
  apiUrl: "http://stalwart/jmap/api",
  accountId: "acc1",
  eventSourceUrl: "",
  uploadUrl: "http://stalwart/jmap/upload/{accountId}/",
  downloadUrl: "",
};

describe("jmap client sieve support", () => {
  it("appends extraUsing capabilities to the using array", async () => {
    let sentBody: { using: string[] } | null = null;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ methodResponses: [["SieveScript/get", {}, "0"]] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const client = createJmapClient({ baseUrl: "http://stalwart", fetchFn });
    await client.request(
      auth,
      session,
      [["SieveScript/get", { accountId: "acc1" }, "0"]],
      ["urn:ietf:params:jmap:sieve"],
    );
    expect(sentBody!.using).toContain("urn:ietf:params:jmap:core");
    expect(sentBody!.using).toContain("urn:ietf:params:jmap:sieve");
  });

  it("does not change the using array when extraUsing is omitted", async () => {
    let sentBody: { using: string[] } | null = null;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ methodResponses: [["Mailbox/get", {}, "0"]] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const client = createJmapClient({ baseUrl: "http://stalwart", fetchFn });
    await client.request(auth, session, [["Mailbox/get", { accountId: "acc1" }, "0"]]);
    expect(sentBody!.using).toEqual([
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:submission",
    ]);
  });

  it("uploads a blob to the accountId-expanded upload url and returns blobId", async () => {
    let sentUrl = "";
    let sentContentType: string | undefined;
    let sentBody: string | null = null;
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      sentUrl = String(url);
      sentContentType = (init!.headers as Record<string, string>)["content-type"];
      sentBody = (init!.body as unknown as string) || "";
      return new Response(JSON.stringify({ blobId: "blob42" }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createJmapClient({ baseUrl: "http://stalwart", fetchFn });
    const blobId = await client.uploadBlob(auth, session, "require [];", "application/sieve");
    expect(blobId).toBe("blob42");
    expect(sentUrl).toBe("http://stalwart/jmap/upload/acc1/");
    expect(sentContentType).toBe("application/sieve");
    expect(sentBody).toBe("require [];");
  });

  it("throws a domain error when upload fails", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = createJmapClient({ baseUrl: "http://stalwart", fetchFn });
    await expect(
      client.uploadBlob(auth, session, "x", "application/sieve"),
    ).rejects.toMatchObject({ code: "stalwart_unavailable" });
  });
});
