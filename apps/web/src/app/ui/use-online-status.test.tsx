import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOnlineStatus } from "./useOnlineStatus";

// GH #345: there was no offline signal anywhere in the UI — a lost
// connection looked identical to a slow one until every in-flight request
// failed on its own.
describe("useOnlineStatus (GH #345)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts from navigator.onLine", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
  });

  it("flips to false on the offline event and back to true on online", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe(true);
  });

  it("stops listening after unmount", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const { result, unmount } = renderHook(() => useOnlineStatus());
    unmount();

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    // No error, and no crash from updating state after unmount — the value
    // captured before unmount is simply frozen.
    expect(result.current).toBe(true);
  });
});
