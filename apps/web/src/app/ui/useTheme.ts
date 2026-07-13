import { useEffect, useState } from "react";

export type Theme = "night" | "light";

const STORAGE_KEY = "cefiro-theme";

function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "night";
  } catch {
    // matchMedia unavailable — use the brand default
    return "night";
  }
}

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "night") return stored;
  } catch {
    // storage unavailable — fall through to the system preference
  }
  return systemTheme();
}

function hasStoredTheme(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "night";
  } catch {
    return false;
  }
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    let media: MediaQueryList;
    try {
      media = window.matchMedia("(prefers-color-scheme: light)");
    } catch {
      return;
    }
    function handleChange(event: MediaQueryListEvent) {
      if (hasStoredTheme()) return;
      setTheme(event.matches ? "light" : "night");
    }
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  function toggleTheme() {
    setTheme((current) => {
      const next = current === "night" ? "light" : "night";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // storage unavailable — the choice just won't persist
      }
      return next;
    });
  }

  return { theme, toggleTheme };
}
