import { describe, expect, it } from "vitest";
import { createQueryClient, DEFAULT_STALE_TIME_MS, LONG_STALE_TIME_MS } from "./queryClient";

// #349: main.tsx used a bare `new QueryClient()` — staleTime: 0,
// refetchOnWindowFocus: true — so every alt-tab and every SSE StateChange
// (useMailEvents.ts) refetched every query on screen, including every
// already-loaded page of the infinite messages list.
describe("createQueryClient", () => {
  it("defaults staleTime to 30s for ordinary queries", () => {
    const client = createQueryClient();
    expect(DEFAULT_STALE_TIME_MS).toBe(30_000);
    expect(client.getDefaultOptions().queries?.staleTime).toBe(30_000);
  });

  it.each([
    [["mail", "identities"], "identities"],
    [["mail", "preferences"], "preferences"],
    [["instance"], "instance settings"],
    [["health"], "health probe"],
  ])("gives the %s query a 5 minute staleTime", (queryKey) => {
    const client = createQueryClient();
    expect(LONG_STALE_TIME_MS).toBe(5 * 60_000);
    expect(client.getQueryDefaults(queryKey)?.staleTime).toBe(5 * 60_000);
  });

  it("leaves an unrelated query key on the 30s default, not the 5-minute one", () => {
    const client = createQueryClient();
    expect(client.getQueryDefaults(["mail", "messages"])?.staleTime).toBeUndefined();
  });
});
