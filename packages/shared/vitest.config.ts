import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text"],
      reportsDirectory: "./coverage",
      // The package is nothing but shared API contracts, so everything under
      // src is a unit under test. index.ts is the barrel that re-exports them
      // (no logic of its own, and importing a module through it rather than
      // directly would only move the same statements around), and tests and
      // generated typings are not units either.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/index.ts"],
      // GH #229: this package had no coverage config at all, so it sat outside
      // the gate the other two packages have had since GH #199 — including
      // api/sieve.ts, the input contract of an injection-sensitive Sieve
      // generator, which had no test file whatsoever.
      //
      // Thresholds are checked per file, not only in aggregate (GH #228): a
      // package this small is exactly where one entirely untested module hides
      // behind a high average — which is precisely what happened to sieve.ts
      // and setup.ts.
      //
      // They sit just under today's measured per-file coverage: every file is
      // at 100% statements/lines/functions, and the lowest branch coverage is
      // profile.ts at 88.88%. A ratchet floor, not a target — raise it as
      // coverage climbs.
      thresholds: {
        perFile: true,
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 85,
      },
    },
  },
});
