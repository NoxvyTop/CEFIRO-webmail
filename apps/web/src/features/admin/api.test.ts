import { describe, expect, it, vi } from "vitest";
import { MailApiError } from "../mailbox/api";
import {
  createAdminUser, fetchAdminInstance, fetchAdminSso, fetchAdminUsers,
  setUserActive, setUserCredential, setUserRole, updateAdminInstance, updateAdminSso,
} from "./api";

const adminUser = {
  id: "u1", email: "a@example.com", displayName: "Admin", role: "admin",
  locale: "es", active: true, mailboxLinked: true,
};

const ssoView = {
  configured: true, issuer: "https://issuer.example", clientId: "client-1", scopes: "openid email",
};

function stubFetchByUrl(handlers: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: string) => {
    const url = String(input);
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) throw new Error(`no handler for ${url}`);
    return handlers[key]!();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("admin api client", () => {
  it("fetches and validates admin users", async () => {
    stubFetchByUrl({ "/api/admin/users": () => new Response(JSON.stringify([adminUser])) });
    const users = await fetchAdminUsers();
    expect(users[0]?.email).toBe("a@example.com");
  });

  it("POSTs the create-user input body", async () => {
    const fetchMock = stubFetchByUrl({
      "/api/admin/users": () => new Response(JSON.stringify(adminUser)),
    });
    const input = { email: "a@example.com", displayName: "Admin", role: "admin" as const, locale: "es" };
    await createAdminUser(input);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("/api/admin/users");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("PUTs {role} to /api/admin/users/:id/role", async () => {
    const fetchMock = stubFetchByUrl({
      "/api/admin/users/u1/role": () => new Response(JSON.stringify(adminUser)),
    });
    await setUserRole("u1", "admin");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("/api/admin/users/u1/role");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ role: "admin" });
  });

  it("PUTs {active} to /api/admin/users/:id/active", async () => {
    const fetchMock = stubFetchByUrl({
      "/api/admin/users/u1/active": () => new Response(JSON.stringify(adminUser)),
    });
    await setUserActive("u1", false);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("/api/admin/users/u1/active");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ active: false });
  });

  it("PUTs {mailPassword} to /api/admin/users/:id/credential and resolves void", async () => {
    const fetchMock = stubFetchByUrl({
      "/api/admin/users/u1/credential": () => new Response(JSON.stringify({ ok: true })),
    });
    await expect(setUserCredential("u1", "supersecret1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("/api/admin/users/u1/credential");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ mailPassword: "supersecret1" });
  });

  it("fetches and validates the SSO view", async () => {
    stubFetchByUrl({ "/api/admin/sso": () => new Response(JSON.stringify(ssoView)) });
    const view = await fetchAdminSso();
    expect(view.issuer).toBe("https://issuer.example");
  });

  it("PUTs the SSO config and resolves void", async () => {
    const fetchMock = stubFetchByUrl({
      "/api/admin/sso": () => new Response(JSON.stringify({ ok: true })),
    });
    const input = {
      issuer: "https://issuer.example", clientId: "client-1",
      clientSecret: "secret", scopes: "openid email",
    };
    await expect(updateAdminSso(input)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("/api/admin/sso");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("fetches and validates the instance settings view", async () => {
    stubFetchByUrl({ "/api/admin/instance": () => new Response(JSON.stringify({ sentWithFooter: true })) });
    const view = await fetchAdminInstance();
    expect(view.sentWithFooter).toBe(true);
  });

  it("PUTs the instance settings and resolves void", async () => {
    const fetchMock = stubFetchByUrl({
      "/api/admin/instance": () => new Response(JSON.stringify({ sentWithFooter: true })),
    });
    await expect(updateAdminInstance({ sentWithFooter: true })).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("/api/admin/instance");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ sentWithFooter: true });
  });

  it("throws MailApiError with code 'forbidden' on 403", async () => {
    stubFetchByUrl({
      "/api/admin/users": () => new Response(JSON.stringify({ code: "forbidden", message: "no", traceId: "t" }), { status: 403 }),
    });
    await expect(fetchAdminUsers()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(fetchAdminUsers()).rejects.toBeInstanceOf(MailApiError);
  });
});
