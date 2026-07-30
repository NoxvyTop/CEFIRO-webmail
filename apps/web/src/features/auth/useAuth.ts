import { useQuery, useQueryClient } from "@tanstack/react-query";
import { sessionUserSchema, type SessionUser } from "@webmail/shared";

async function fetchMe(): Promise<SessionUser | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) return null;
  return sessionUserSchema.parse(await res.json());
}

export function useAuth() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["auth", "me"], queryFn: fetchMe });

  async function logout(): Promise<void> {
    await fetch("/api/auth/logout", { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
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
