import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

/**
 * Stubs `window.matchMedia("(prefers-color-scheme: dark)")` with a fake
 * MediaQueryList that supports the addEventListener/removeEventListener
 * subscription API used to follow live system-preference changes.
 */
function stubMatchMedia(initialMatches: boolean) {
  const listeners: Array<(event: { matches: boolean }) => void> = [];
  const mediaQueryList = {
    matches: initialMatches,
    addEventListener: vi.fn(
      (_type: string, handler: (event: { matches: boolean }) => void) => {
        listeners.push(handler);
      },
    ),
    removeEventListener: vi.fn(
      (_type: string, handler: (event: { matches: boolean }) => void) => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      },
    ),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mediaQueryList),
  );
  return {
    emitChange(matches: boolean) {
      mediaQueryList.matches = matches;
      for (const handler of listeners) handler({ matches });
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTheme", () => {
  it("prefers a stored light choice over a dark system preference", () => {
    stubMatchMedia(true);
    localStorage.setItem("cefiro-theme", "light");

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("prefers a stored night choice over a light system preference", () => {
    stubMatchMedia(false);
    localStorage.setItem("cefiro-theme", "night");

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("night");
    expect(document.documentElement.dataset.theme).toBe("night");
  });

  it("follows a dark system preference when nothing is stored", () => {
    stubMatchMedia(true);

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("night");
    expect(document.documentElement.dataset.theme).toBe("night");
    expect(localStorage.getItem("cefiro-theme")).toBeNull();
  });

  it("follows a light system preference when nothing is stored", () => {
    stubMatchMedia(false);

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("cefiro-theme")).toBeNull();
  });

  it("falls back to light when matchMedia is unavailable", () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to system detection when the stored value is invalid", () => {
    stubMatchMedia(true);
    localStorage.setItem("cefiro-theme", "neon");

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("night");
  });

  it("follows live system-preference changes while no explicit choice is stored", () => {
    const media = stubMatchMedia(false);

    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");

    act(() => media.emitChange(true));

    expect(result.current.theme).toBe("night");
    expect(document.documentElement.dataset.theme).toBe("night");
    expect(localStorage.getItem("cefiro-theme")).toBeNull();

    act(() => media.emitChange(false));

    expect(result.current.theme).toBe("light");
  });

  it("stops following the system once the user explicitly toggles", () => {
    const media = stubMatchMedia(false);

    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("night");
    expect(localStorage.getItem("cefiro-theme")).toBe("night");

    // System flips back to light, but the explicit choice must win now.
    act(() => media.emitChange(false));

    expect(result.current.theme).toBe("night");
  });

  it("toggles, persists the explicit choice and applies it", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("night");
    expect(localStorage.getItem("cefiro-theme")).toBe("night");
    expect(document.documentElement.dataset.theme).toBe("night");

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("cefiro-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
