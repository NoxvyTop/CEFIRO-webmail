import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTheme } from "./useTheme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("useTheme", () => {
  it("defaults to night and applies it to the document", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("night");
    expect(document.documentElement.dataset.theme).toBe("night");
  });

  it("reads a stored light preference", () => {
    localStorage.setItem("cefiro-theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("toggles, persists and applies", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("cefiro-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores invalid stored values", () => {
    localStorage.setItem("cefiro-theme", "neon");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("night");
  });
});
