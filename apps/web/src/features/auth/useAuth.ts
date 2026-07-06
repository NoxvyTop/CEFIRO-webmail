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
