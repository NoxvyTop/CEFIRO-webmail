import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Provisions an isolated, throwaway Postgres database for the whole run and
    // drops it afterwards, so the suite never writes into a shared/development
    // database and cleans up after itself (GH #181). Requires DATABASE_URL.
    globalSetup: ["./vitest.global-setup.ts"],
    // Integration tests share one Postgres instance and a singleton
    // sso_config row (id = 1). Running test files in parallel lets
    // concurrent beforeAll() calls stomp each other's encrypted
    // client secret, causing intermittent AES-GCM decrypt failures.
    // Serialize file execution to keep the shared row consistent.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      // index.ts only boots the HTTP listener (a process entrypoint, not a
      // unit); tests and generated typings are not units under test either.
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/index.ts",
        // Type-only modules (GH #228). These declare interfaces and dependency
        // bundles and emit no runtime code at all, so every importer uses
        // `import type` and the module is never loaded — v8 reports each of
        // them as a flat 0%, which is not a coverage gap and cannot be closed
        // by any test. Excluding them is what lets the per-file floor below be
        // a real floor instead of being pinned at zero by files that contain
        // nothing to execute.
        "src/core/ai.ts",
        "src/modules/ai/context.ts",
        "src/modules/contacts/context.ts",
        // Test harness, not a unit under test: this is the accessor the suite
        // uses to reach the throwaway database vitest.global-setup.ts
        // provisions (GH #181). It is only ever imported by tests, the same
        // reason the web package excludes src/test/**.
        "src/infra/db/test-db.ts",
      ],
      // Thresholds are checked PER FILE (GH #228). Before this they were
      // aggregate-only, so a file could rot all the way to zero while the
      // package average stayed comfortably above the gate — and infra/db/
      // health.ts had (0%, now covered), alongside the type-only modules
      // excluded above.
      //
      // Note that `perFile` is a single switch over every threshold set, not a
      // per-set option (vitest's BaseCoverageProvider.checkThresholds reads
      // `options.thresholds.perFile` once for all of them), so these numbers
      // are now a floor each individual file must clear rather than an average
      // the package must clear. That is the stronger guarantee for the failure
      // this issue is about; the aggregate figures stay visible in the report.
      //
      // The floor sits under the worst-covered file measured today —
      // infra/db/migrate.ts (60% lines, most of its work happening in
      // globalSetup, outside the instrumented workers), modules/auth/router.ts
      // (40% functions) and modules/ai/router.ts (71.15% branches) — with room
      // left for the ordinary churn of a file being edited. A ratchet floor,
      // not a target: raise it as the weakest files improve. For reference,
      // today's aggregate is lines/statements 95.80%, functions 95.16%,
      // branches 87.34%.
      thresholds: {
        perFile: true,
        lines: 55,
        statements: 55,
        functions: 35,
        branches: 60,
      },
    },
  },
});
