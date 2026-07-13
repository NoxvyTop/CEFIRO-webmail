import { readTheme } from "./useTheme";

// Theme sync before React mounts: applies the resolved preference over the
// hardcoded data-theme="night" fallback in index.html. Runs at module
// evaluation (imported first in main.tsx) — this is pre-mount, NOT pre-paint:
// module scripts are deferred, so a brief night flash is possible on slow
// loads for light-preference users. Accepted tradeoff to keep script-src
// 'self' without inline-script allowlisting. themeInit owns this pre-mount
// window; useTheme's mount effect owns the attribute thereafter.
document.documentElement.dataset.theme = readTheme();
