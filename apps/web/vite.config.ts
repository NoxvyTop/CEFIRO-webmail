/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

// A <script> with no src, i.e. one whose body is inline in the HTML.
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>/i;

/**
 * Fails the production build if Vite emits an inline <script> (GH #47).
 *
 * The server ships `script-src 'self'` with no nonce and no hash (see
 * DEFAULT_CSP in apps/server/src/app.ts), so an inline bootstrap script would be
 * refused by the browser — and refused the way CSP refuses things: silently, at
 * runtime, on the production build only, on a blank page with a console message
 * nobody is watching. Nothing about the current output emits one, which is
 * exactly why this is worth pinning: it is a property of Vite's HTML emission,
 * not of any code in this repo, so it can change under us on a version bump.
 *
 * Checked here rather than in a test because the artefact only exists after a
 * build, and this is the one place that is guaranteed to run for every build
 * that could be deployed.
 */
function assertNoInlineScripts(): Plugin {
  return {
    name: "cefiro:assert-no-inline-scripts",
    enforce: "post",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (!fileName.endsWith(".html") || output.type !== "asset") continue;
        if (!INLINE_SCRIPT.test(String(output.source))) continue;
        this.error(
          `${fileName} contains an inline <script>, which the deployed ` +
            "Content-Security-Policy (script-src 'self', no nonce/hash) blocks. " +
            "Move the code into the bundle, or add a nonce/hash to DEFAULT_CSP " +
            "in apps/server/src/app.ts — see GH #47.",
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), assertNoInlineScripts()],
  server: {
    proxy: { "/api": "http://localhost:8080" },
    watch: process.env.CHOKIDAR_USEPOLLING
      ? { usePolling: true, interval: 300 }
      : undefined,
  },
  build: {
    // Emit source maps for the production bundle but keep them "hidden": the
    // .map files are written (so error monitoring can symbolicate stack
    // traces) without appending a //# sourceMappingURL comment that would
    // point browsers/curious users straight at our original source.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        // Split the heaviest third-party dependencies into their own vendor
        // chunks so they cache independently and stay out of the main entry
        // chunk (which was ~1 MB — over the 500 kB warning). pdf.js is already
        // loaded on demand (dynamic import in PdfThumbnail); naming it here
        // keeps it isolated. TipTap only ships once the lazy Composer is
        // opened, so pinning it to its own chunk keeps it off the first-paint
        // path. The React/router/query runtime is shared by every screen, so
        // isolating it both shrinks the entry chunk and lets it cache across
        // deploys that don't touch these versions.
        // Function form (not the object form): it matches by resolved module
        // path, so transitive-only packages (prosemirror under TipTap,
        // react-router/scheduler under the React runtime) are captured without
        // being listed as resolvable entries.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("pdfjs-dist")) return "pdfjs";
          if (id.includes("@tiptap") || id.includes("prosemirror")) return "tiptap";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/react-router") ||
            id.includes("/scheduler/") ||
            id.includes("@tanstack/react-query")
          ) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    // The repo-level `test` script fans out to every package at once, so on
    // CI three vitest instances compete for the same cores. Left unbounded,
    // each one sizes its pool to the whole machine and they oversubscribe it
    // badly enough that slow-but-honest tests — a pdf.js render, a debounced
    // effect — miss the default 5s window and fail. Those failures name a
    // random file each run and look nothing like contention, which is what
    // made them expensive to diagnose (GH #147).
    //
    // Half the cores keeps this package fast while leaving room for the other
    // two, and a longer timeout stops a merely slow test from being reported
    // as a broken one.
    maxWorkers: "50%",
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text"],
      reportsDirectory: "./coverage",
      // Measure the app's own source. Tests, the vitest setup shim, generated
      // typings and the Vite entrypoint (which only mounts <App/>) are not units
      // under test, so counting them would only dilute the signal.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
      // Thresholds are checked PER FILE (GH #228). Before this they were
      // aggregate-only, so a file could rot all the way to zero while the
      // package average stayed comfortably above the gate — and two already
      // had: app/ui/themeInit.ts at 0% and features/composer/aiApi.ts at
      // 10.52% lines / 0% functions, both now covered.
      //
      // Note that `perFile` is a single switch over every threshold set, not a
      // per-set option (vitest's BaseCoverageProvider.checkThresholds reads
      // `options.thresholds.perFile` once for all of them), so these numbers
      // are now a floor each individual file must clear rather than an average
      // the package must clear. That is the stronger guarantee for the failure
      // this issue is about; the aggregate figures stay visible in the report.
      //
      // The floor sits one notch under the worst-covered file measured today —
      // App.tsx (82.23% lines/statements, 36.36% functions) and
      // features/admin/api.ts (58.33% branches). Today's aggregate, for
      // reference, is lines/statements 96.70%, functions 87.93%, branches
      // 91.30%.
      //
      // GH #245 re-measured these. They were set to 75/30/50 while several
      // agents were editing at once, which left functions 6 points and branches
      // 8 points below the real worst file — enough that a NEW file could land
      // at 31% functions, fail nothing, and become the new worst. The gap is
      // now 2-3 points, which is the margin an ordinary edit needs and not
      // more.
      //
      // Why not sit exactly on the measurement: these are small files, so a
      // percentage point is not a fine-grained unit. App.tsx covers 4 of its 11
      // functions; adding a twelfth uncovered one drops it to 33.33%. A floor
      // at 36 would fail on that, which is churn rather than regression. A
      // floor at 34 fails on a real DROP — a function that used to be covered
      // and no longer is — which is what a ratchet is for.
      //
      // A ratchet, not a target: raise it as the weakest files improve, and
      // close the gap on a file by testing it rather than by lowering this.
      thresholds: {
        perFile: true,
        lines: 80,
        statements: 80,
        functions: 34,
        branches: 55,
      },
    },
  },
});
