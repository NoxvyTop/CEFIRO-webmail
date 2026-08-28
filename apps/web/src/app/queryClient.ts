import { QueryClient } from "@tanstack/react-query";

// #349: the default QueryClient (staleTime: 0, refetchOnWindowFocus: true)
// refetched EVERY query on every alt-tab, and useMailEvents.ts's SSE
// StateChange handler does the same on every server-pushed change —
// including every already-loaded page of the infinite messages list (see
// MessageList.tsx). 30s keeps the UI reasonably fresh without turning a
// window focus or a live update into a refetch storm.
export const DEFAULT_STALE_TIME_MS = 30_000;

// Identities, preferences, the instance-wide settings and the health probe
// change rarely — an admin action, a session preference toggle, an instance
// setting — so refetching them on the same 30s/focus/StateChange cadence as
// mail data is pure waste. Registered once here as per-query-key defaults
// rather than a `staleTime` option repeated at each of the several
// `useQuery` call sites that share these keys (App.tsx, Composer.tsx,
// MailPage.tsx, ThreadView.tsx) — a shared defaults registry can't be missed
// at a new call site the way a copy-pasted inline option can.
export const LONG_STALE_TIME_MS = 5 * 60_000;

export const LONG_LIVED_QUERY_KEYS: readonly (readonly unknown[])[] = [
  ["mail", "identities"],
  ["mail", "preferences"],
  ["instance"],
  ["health"],
];

export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: DEFAULT_STALE_TIME_MS } },
  });
  for (const queryKey of LONG_LIVED_QUERY_KEYS) {
    client.setQueryDefaults(queryKey, { staleTime: LONG_STALE_TIME_MS });
  }
  return client;
}
