import {
  adminSsoViewSchema, adminUserSchema, adminUsersPageSchema, instanceSettingsViewSchema,
  type AdminSsoView, type AdminUser, type AdminUsersPage, type CreateUserInput,
  type InstanceSettingsView,
} from "@webmail/shared";
import { MailApiError } from "../mailbox/api";

async function parseError(res: Response): Promise<never> {
  let code = "internal";
  try {
    code = ((await res.json()) as { code?: string }).code ?? "internal";
  } catch {
    // non-json error body — keep default code
  }
  throw new MailApiError(res.status, code);
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function fetchAdminUsers(
  params: { page: number; pageSize: number; search?: string },
): Promise<AdminUsersPage> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.search) query.set("search", params.search);
  const res = await fetch(`/api/admin/users?${query.toString()}`);
  if (!res.ok) return parseError(res);
  return adminUsersPageSchema.parse(await res.json());
}

export async function createAdminUser(input: CreateUserInput): Promise<AdminUser> {
  const res = await fetch("/api/admin/users", jsonRequest("POST", input));
  if (!res.ok) return parseError(res);
  return adminUserSchema.parse(await res.json());
}

export async function setUserRole(id: string, role: "employee" | "admin"): Promise<AdminUser> {
  const res = await fetch(
    `/api/admin/users/${encodeURIComponent(id)}/role`,
    jsonRequest("PUT", { role }),
  );
  if (!res.ok) return parseError(res);
  return adminUserSchema.parse(await res.json());
}

export async function setUserActive(id: string, active: boolean): Promise<AdminUser> {
  const res = await fetch(
    `/api/admin/users/${encodeURIComponent(id)}/active`,
    jsonRequest("PUT", { active }),
  );
  if (!res.ok) return parseError(res);
  return adminUserSchema.parse(await res.json());
}

export async function setUserCredential(id: string, mailPassword: string): Promise<void> {
  const res = await fetch(
    `/api/admin/users/${encodeURIComponent(id)}/credential`,
    jsonRequest("PUT", { mailPassword }),
  );
  if (!res.ok) return parseError(res);
}

export async function fetchAdminSso(): Promise<AdminSsoView> {
  const res = await fetch("/api/admin/sso");
  if (!res.ok) return parseError(res);
  return adminSsoViewSchema.parse(await res.json());
}

export async function updateAdminSso(input: {
  issuer: string; clientId: string; clientSecret: string; scopes: string; providerName?: string;
}): Promise<void> {
  const res = await fetch("/api/admin/sso", jsonRequest("PUT", input));
  if (!res.ok) return parseError(res);
}

export async function fetchAdminInstance(): Promise<InstanceSettingsView> {
  const res = await fetch("/api/admin/instance");
  if (!res.ok) return parseError(res);
  return instanceSettingsViewSchema.parse(await res.json());
}

export async function updateAdminInstance(input: { sentWithFooter: boolean }): Promise<void> {
  const res = await fetch("/api/admin/instance", jsonRequest("PUT", input));
  if (!res.ok) return parseError(res);
}
