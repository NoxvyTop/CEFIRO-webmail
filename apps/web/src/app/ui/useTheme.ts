import { useEffect, useState } from "react";

export type Theme = "night" | "light";

const STORAGE_KEY = "cefiro-theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "night") return stored;
  } catch {
    // storage unavailable — use the default
  }
  return "night";
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // storage unavailable — the preference just won't persist
    }
  }, [theme]);

  function toggleTheme() {
    setTheme((current) => (current === "night" ? "light" : "night"));
  }

  return { theme, toggleTheme };
}
