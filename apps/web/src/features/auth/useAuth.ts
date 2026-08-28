import { useQuery, useQueryClient } from "@tanstack/react-query";
import { sessionUserSchema, type SessionUser } from "@webmail/shared";
import { parseError } from "../mailbox/api";
import { clearAllSummaryCache } from "../reader/summaryCache";

// The session query RequireAuth gates every screen on. Exported so anything
// that independently learns the session is gone — the SSE stream in
// useMailEvents, GH #243 — invalidates the key this hook actually reads
// instead of its own copy of it.
export const AUTH_QUERY_KEY = ["auth", "me"];

export const AUTH_ME_URL = "/api/auth/me";

async function fetchMe(): Promise<SessionUser | null> {
  const res = await fetch(AUTH_ME_URL);
  if (res.status === 401) return null;
  // GH #341: any other non-OK status (502/503 from the proxy while the
  // backend is down) used to fall straight into
  // sessionUserSchema.parse(await res.json()), which throws on a non-JSON or
  // unexpected body. After RequireAuth's retries that left `user` undefined —
  // indistinguishable from "not signed in" — so a backend outage showed the
  // login screen instead of a "service unavailable" state.
  if (!res.ok) return parseError(res);
  return sessionUserSchema.parse(await res.json());
}

export function useAuth() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: AUTH_QUERY_KEY, queryFn: fetchMe });

  async function logout(): Promise<void> {
    await fetch("/api/auth/logout", { method: "POST" });
    // GH #341: used to invalidate only AUTH_QUERY_KEY, so every other cached
    // query (mail, contacts, profile...) stayed in memory for its gcTime —
    // signing in as a different user in the same tab could show the previous
    // user's mailbox/avatar until each query happened to refetch. Clearing
    // the whole cache, plus the localStorage AI summary layer underneath it,
    // guarantees nothing from the old session survives the switch.
    queryClient.clear();
    clearAllSummaryCache();
  }

  return {
    user: query.data,
    isLoading: query.isLoading,
    // GH #341: RequireAuth uses this to tell "the service is unreachable"
    // (retry) apart from "no session" (show the login screen) — before this,
    // fetchMe's own error was indistinguishable from an ordinary signed-out
    // state once it had propagated through `user === undefined`.
    isError: query.isError,
    refetch: query.refetch,
    logout,
  };
}

// "rate_limited" is distinct from "error" so the emergency form can tell an
// operator that the break-glass login is throttled (429, see GH #183) rather
// than that the credential was wrong. "network_error" is distinct again so a
// dropped connection does not read as a rejected credential (GH #273): the
// request never reached the server, so nothing was judged wrong about it.
export type BootstrapLoginResult = "ok" | "rate_limited" | "network_error" | "error";

export async function bootstrapLogin(
  email: string,
  password: string,
): Promise<BootstrapLoginResult> {
  let res: Response;
  try {
    res = await fetch("/api/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    // fetch rejects only when the request never completed — offline, DNS,
    // connection reset. Left uncaught this was an unhandled promise rejection
    // with zero feedback on the emergency form (GH #273).
    return "network_error";
  }
  if (res.ok) return "ok";
  if (res.status === 429) return "rate_limited";
  return "error";
}
