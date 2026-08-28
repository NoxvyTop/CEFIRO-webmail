import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import { useAuth } from "./useAuth";

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// GH #341: logout() used to invalidate only ["auth","me"] — every other
// cached query (mail, contacts, profile...) stayed in memory for gcTime,
// so signing in as a different user in the same tab showed the previous
// user's mailbox/avatar until each query happened to refetch.
describe("useAuth logout (GH #341)", () => {
  it("clears the entire query cache, not just the auth key", async () => {
    const { client, wrapper } = makeWrapper();
    client.setQueryData(["mail", "messages", "mb-inbox"], { stale: "previous-user-data" });
    client.setQueryData(["profile"], { displayName: "Previous User" });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.logout();
    });

    expect(client.getQueryData(["mail", "messages", "mb-inbox"])).toBeUndefined();
    expect(client.getQueryData(["profile"])).toBeUndefined();
  });

  it("clears the localStorage AI summary cache on logout", async () => {
    localStorage.setItem("cefiro-ai-summary:m:e1", JSON.stringify({ v: 1, bullets: ["x"], ts: 1 }));
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.logout();
    });

    expect(localStorage.getItem("cefiro-ai-summary:m:e1")).toBeNull();
  });
});
