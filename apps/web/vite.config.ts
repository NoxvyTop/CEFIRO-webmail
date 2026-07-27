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
  },
});
