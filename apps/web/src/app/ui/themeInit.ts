import { readTheme } from "./useTheme";

// Theme sync before React mounts: applies the resolved preference (stored
// choice > system prefers-color-scheme > light brand default, see
// useTheme.ts) over the hardcoded data-theme="light" fallback in index.html.
// Runs at module evaluation (imported first in main.tsx) — this is
// pre-mount, NOT pre-paint: module scripts are deferred, so a brief light
// flash is possible on slow loads for dark-preference users. Accepted
// tradeoff to keep script-src 'self' without inline-script allowlisting.
// themeInit owns this pre-mount window; useTheme's mount effect owns the
// attribute thereafter.
document.documentElement.dataset.theme = readTheme();
