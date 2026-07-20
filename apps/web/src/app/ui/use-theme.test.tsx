import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTheme", () => {
  it("defaults to night when nothing is stored, regardless of a light system preference", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("night");
    expect(document.documentElement.dataset.theme).toBe("night");
    expect(localStorage.getItem("cefiro-theme")).toBeNull();
  });

  it("falls back to night when matchMedia is unavailable", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("night");
  });

  it("never reads or subscribes to prefers-color-scheme — night is the brand default, not a system follow", () => {
    const matchMedia = vi.fn();
    vi.stubGlobal("matchMedia", matchMedia);

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("night");
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("prefers the stored choice over the brand default", () => {
    localStorage.setItem("cefiro-theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });

  it("toggles, persists the explicit choice and applies it", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("cefiro-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("night");
    expect(localStorage.getItem("cefiro-theme")).toBe("night");
  });

  it("ignores invalid stored values and falls back to night", () => {
    localStorage.setItem("cefiro-theme", "neon");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("night");
  });
});
