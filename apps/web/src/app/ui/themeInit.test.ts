import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GH #228: themeInit.ts measured 0% — nothing imported it under test, so the
// pre-mount theme sync (the thing standing between a dark-preference user and a
// flash of the light theme) had no protection at all.
//
// It is a side-effect module: importing it *is* the behaviour. So each case
// arranges the environment first, then resets the module registry and imports
// it fresh, rather than importing once at the top of the file.

async function importThemeInit(): Promise<void> {
  vi.resetModules();
  await import("./themeInit");
}

function stubMatchMedia(prefersDark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: prefersDark && query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("themeInit", () => {
  it("applies the stored explicit choice over the system preference", async () => {
    localStorage.setItem("cefiro-theme", "night");
    stubMatchMedia(false);

    await importThemeInit();

    expect(document.documentElement.dataset.theme).toBe("night");
  });

  it("follows the system preference when no choice is stored", async () => {
    stubMatchMedia(true);

    await importThemeInit();

    expect(document.documentElement.dataset.theme).toBe("night");
  });

  it("falls back to the light brand default when neither is available", async () => {
    vi.stubGlobal("matchMedia", undefined);

    await importThemeInit();

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("overwrites the light fallback index.html hardcodes", async () => {
    document.documentElement.dataset.theme = "light";
    localStorage.setItem("cefiro-theme", "night");
    stubMatchMedia(false);

    await importThemeInit();

    expect(document.documentElement.dataset.theme).toBe("night");
  });
});
