import { useEffect, useState } from "react";

export type Theme = "night" | "light";

const STORAGE_KEY = "cefiro-theme";

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "night") return stored;
  } catch {
    // storage unavailable — fall through to the brand default
  }
  // No explicit user choice: night is the brand default (docs/design/cefiro/README.md).
  // The system color scheme is never consulted here — following it would require
  // an explicit "system" preference, which does not exist today.
  return "night";
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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
