import { useEffect, useState } from "react";

export type Theme = "night" | "light";

const STORAGE_KEY = "cefiro-theme";
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "night") return stored;
  } catch {
    // storage unavailable — no explicit choice to honor
  }
  return null;
}

function readSystemTheme(): Theme {
  try {
    if (typeof matchMedia !== "function") return "light";
    return matchMedia(DARK_SCHEME_QUERY).matches ? "night" : "light";
  } catch {
    // matchMedia unavailable or undetectable — fall back to the brand default
    return "light";
  }
}

export function readTheme(): Theme {
  // Resolution order (CLARO-01, product decision): stored explicit choice >
  // system color-scheme auto-discovery > brand default (light).
  return readStoredTheme() ?? readSystemTheme();
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Follow live system-preference changes only while no explicit choice is
  // stored. Once toggleTheme persists a choice, this handler bails out and
  // the system is no longer followed — the explicit choice wins from then on.
  useEffect(() => {
    let mediaQuery: MediaQueryList;
    try {
      if (typeof matchMedia !== "function") return;
      mediaQuery = matchMedia(DARK_SCHEME_QUERY);
      if (typeof mediaQuery.addEventListener !== "function") return;
    } catch {
      return;
    }

    function handleChange(event: MediaQueryListEvent) {
      if (readStoredTheme() !== null) return; // explicit choice wins now
      setTheme(event.matches ? "night" : "light");
    }

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
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
