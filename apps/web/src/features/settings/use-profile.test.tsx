import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileView, SessionUser } from "@webmail/shared";
import { PROFILE_QUERY_KEY, useProfile } from "./useProfile";

const { fetchProfile } = vi.hoisted(() => ({ fetchProfile: vi.fn() }));
vi.mock("./api", () => ({ fetchProfile }));

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../auth/useAuth", () => ({ useAuth }));

const sessionUser: SessionUser = {
  userId: "u1",
  email: "carla@noxvytop.com",
  displayName: "Carla Bosch",
  role: "employee",
  locale: "es",
};

const profile: ProfileView = {
  displayName: "Carla Bosch",
  email: "carla@noxvytop.com",
  avatarDataUrl: null,
};

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fetch the profile when there is no authenticated user", async () => {
    useAuth.mockReturnValue({ user: null, isLoading: false, logout: vi.fn() });
    fetchProfile.mockResolvedValue(profile);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useProfile(), { wrapper: createWrapper(client) });

    // A disabled query never enters a fetching state.
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();

    // Give react-query a tick; if the enabled guard were missing, a fetch
    // would already be in flight by now (this is the pre-login doomed-request
    // scenario the reviewers flagged).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it("fetches the profile once an authenticated user is present", async () => {
    useAuth.mockReturnValue({ user: sessionUser, isLoading: false, logout: vi.fn() });
    fetchProfile.mockResolvedValue(profile);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useProfile(), { wrapper: createWrapper(client) });

    await waitFor(() => expect(result.current.data).toEqual(profile));
    expect(fetchProfile).toHaveBeenCalledTimes(1);
  });

  it("is configured with a 5-minute staleTime and refetchOnWindowFocus disabled", async () => {
    useAuth.mockReturnValue({ user: sessionUser, isLoading: false, logout: vi.fn() });
    fetchProfile.mockResolvedValue(profile);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useProfile(), { wrapper: createWrapper(client) });
    await waitFor(() => expect(result.current.data).toEqual(profile));

    // Query.options is typed as the narrower QueryOptions (no staleTime /
    // refetchOnWindowFocus); the resolved observer options carry them.
    const observerOptions = client.getQueryCache().find({ queryKey: PROFILE_QUERY_KEY })
      ?.observers[0]?.options;
    expect(observerOptions?.staleTime).toBe(5 * 60 * 1000);
    expect(observerOptions?.refetchOnWindowFocus).toBe(false);
  });

  it("does not refetch on remount within the stale window", async () => {
    useAuth.mockReturnValue({ user: sessionUser, isLoading: false, logout: vi.fn() });
    fetchProfile.mockResolvedValue(profile);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const first = renderHook(() => useProfile(), { wrapper: createWrapper(client) });
    await waitFor(() => expect(first.result.current.data).toEqual(profile));
    first.unmount();

    const second = renderHook(() => useProfile(), { wrapper: createWrapper(client) });
    await waitFor(() => expect(second.result.current.data).toEqual(profile));

    // Same underlying cache entry, still within the 5-minute staleTime: the
    // ~1 MiB avatar payload must not be redownloaded on a plain remount.
    expect(fetchProfile).toHaveBeenCalledTimes(1);
  });
});
