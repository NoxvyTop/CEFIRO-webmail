/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
      // Thresholds sit just under today's measured coverage (lines 95.46%,
      // statements 95.46%, functions 86.02%, branches 90.29%), floored to fives
      // so the gate is green now but a genuine regression trips it. They are a
      // ratchet floor, not a target — raise them as coverage climbs.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 85,
        branches: 85,
      },
    },
  },
});
