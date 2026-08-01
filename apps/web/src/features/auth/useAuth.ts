import { useQuery, useQueryClient } from "@tanstack/react-query";
import { sessionUserSchema, type SessionUser } from "@webmail/shared";

// The session query RequireAuth gates every screen on. Exported so anything
// that independently learns the session is gone — the SSE stream in
// useMailEvents, GH #243 — invalidates the key this hook actually reads
// instead of its own copy of it.
export const AUTH_QUERY_KEY = ["auth", "me"];

export const AUTH_ME_URL = "/api/auth/me";

async function fetchMe(): Promise<SessionUser | null> {
  const res = await fetch(AUTH_ME_URL);
  if (res.status === 401) return null;
  return sessionUserSchema.parse(await res.json());
}

export function useAuth() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: AUTH_QUERY_KEY, queryFn: fetchMe });

  async function logout(): Promise<void> {
    await fetch("/api/auth/logout", { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
  }

  return { user: query.data, isLoading: query.isLoading, logout };
}

// "rate_limited" is distinct from "error" so the emergency form can tell an
// operator that the break-glass login is throttled (429, see GH #183) rather
// than that the credential was wrong.
export type BootstrapLoginResult = "ok" | "rate_limited" | "error";

export async function bootstrapLogin(
  email: string,
  password: string,
): Promise<BootstrapLoginResult> {
  const res = await fetch("/api/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) return "ok";
  if (res.status === 429) return "rate_limited";
  return "error";
}
