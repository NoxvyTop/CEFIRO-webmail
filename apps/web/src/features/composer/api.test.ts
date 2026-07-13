import { describe, expect, it, vi } from "vitest";
import {
  createSignature, deleteSignature, fetchIdentities, fetchSignatures,
  sendEmail, updateSignature, uploadAttachment,
} from "./api";

const identity = { id: "id1", name: "Alice", email: "alice@example.com" };
const signature = { id: "sig1", name: "Default", contentHtml: "<p>Best</p>", isDefault: true };

describe("composer api client", () => {
  it("fetches and validates identities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([identity]))));
    expect((await fetchIdentities())[0]?.email).toBe("alice@example.com");
  });

  it("throws MailApiError with the envelope code on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: "mail_not_configured", message: "x", traceId: "t" }), { status: 503 }),
    ));
    await expect(fetchIdentities()).rejects.toMatchObject({ status: 503, code: "mail_not_configured" });
  });

  it("fetches and validates signatures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([signature]))));
    expect((await fetchSignatures())[0]?.name).toBe("Default");
  });

  type FetchMock = (input: string, init?: RequestInit) => Promise<Response>;

  it("POSTs a new signature", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(signature))) as unknown as FetchMock;
    vi.stubGlobal("fetch", fetchMock);
    const result = await createSignature({ name: "Default", contentHtml: "<p>Best</p>", isDefault: true });
    expect(result.id).toBe("sig1");
    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(String(url)).toBe("/api/mail/signatures");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Default", contentHtml: "<p>Best</p>", isDefault: true });
  });

  it("PUTs an updated signature", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(signature))) as unknown as FetchMock;
    vi.stubGlobal("fetch", fetchMock);
    await updateSignature("sig1", { name: "Default", contentHtml: "<p>Best</p>", isDefault: true });
    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(String(url)).toBe("/api/mail/signatures/sig1");
    expect(init?.method).toBe("PUT");
  });

  it("DELETEs a signature", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })) as unknown as FetchMock;
    vi.stubGlobal("fetch", fetchMock);
    await deleteSignature("sig1");
    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(String(url)).toBe("/api/mail/signatures/sig1");
    expect(init?.method).toBe("DELETE");
  });

  it("POSTs a new email", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }))) as unknown as FetchMock;
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      identityId: "id1", to: [{ name: null, email: "bob@example.com" }], cc: [], bcc: [],
      subject: "Hi", textBody: "hello", attachments: [],
    };
    await sendEmail(input as never);
    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(String(url)).toBe("/api/mail/send");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  class FakeXhrUpload {
    onprogress: ((e: { loaded: number; total: number }) => void) | null = null;
  }

  class FakeXhr {
    static instances: FakeXhr[] = [];
    upload = new FakeXhrUpload();
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    status = 200;
    responseText = "";
    method = "";
    url = "";
    headers: Record<string, string> = {};
    body: unknown;

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(key: string, value: string) {
      this.headers[key] = value;
    }

    send(body: unknown) {
      this.body = body;
      FakeXhr.instances.push(this);
    }
  }

  it("uploads an attachment via XMLHttpRequest and reports progress", async () => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
    const file = new File(["hello"], "a.png", { type: "image/png" });
    const onProgress = vi.fn();

    const promise = uploadAttachment(file, onProgress);
    const xhr = FakeXhr.instances[0];
    expect(xhr).toBeDefined();
    expect(xhr?.method).toBe("POST");
    expect(xhr?.url).toBe("/api/mail/blobs");
    expect(xhr?.headers["content-type"]).toBe("image/png");

    xhr?.upload.onprogress?.({ loaded: 50, total: 100 });
    expect(onProgress).toHaveBeenCalledWith(0.5);

    xhr!.status = 200;
    xhr!.responseText = JSON.stringify({ blobId: "blob1", type: "image/png", size: 5 });
    xhr?.onload?.();

    await expect(promise).resolves.toEqual({ blobId: "blob1", type: "image/png", size: 5 });
  });

  it("rejects with MailApiError on non-2xx upload response", async () => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
    const file = new File(["hello"], "a.bin", { type: "" });
    const promise = uploadAttachment(file);
    const xhr = FakeXhr.instances[0];
    expect(xhr?.headers["content-type"]).toBe("application/octet-stream");

    xhr!.status = 500;
    xhr!.responseText = JSON.stringify({ code: "internal", message: "boom", traceId: "t" });
    xhr?.onload?.();

    await expect(promise).rejects.toMatchObject({ status: 500, code: "internal" });
  });

  it("rejects invalid response shapes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ nope: 1 }))));
    await expect(fetchIdentities()).rejects.toThrow();
  });
});
