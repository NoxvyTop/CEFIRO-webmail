import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

type Listener = (event: { matches: boolean }) => void;

function stubMatchMedia(light: boolean) {
  const listeners: Listener[] = [];
  const media = {
    matches: light,
    addEventListener: (_: string, listener: Listener) => listeners.push(listener),
    removeEventListener: (_: string, listener: Listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return {
    fireChange(matches: boolean) {
      for (const listener of [...listeners]) listener({ matches });
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
  it("follows a light system preference when nothing is stored", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("cefiro-theme")).toBeNull();
  });

  it("defaults to night on a dark system preference", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("night");
    expect(localStorage.getItem("cefiro-theme")).toBeNull();
  });

  it("prefers the stored choice over the system", () => {
    stubMatchMedia(true);
    localStorage.setItem("cefiro-theme", "night");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("night");
  });

  it("toggles, persists the explicit choice and applies it", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("cefiro-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows live system changes while no choice is stored", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("night");
    act(() => media.fireChange(true));
    expect(result.current.theme).toBe("light");
  });

  it("stops following the system after an explicit choice", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    act(() => media.fireChange(false));
    expect(result.current.theme).toBe("light");
  });

  it("ignores invalid stored values and falls back to the system", () => {
    stubMatchMedia(true);
    localStorage.setItem("cefiro-theme", "neon");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });

  it("falls back to night when matchMedia is unavailable", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("night");
  });
});
