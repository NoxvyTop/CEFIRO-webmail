import { defineConfig } from "vitest/config";
import { TEST_WORKER_COUNT } from "./vitest.workers";

export default defineConfig({
  test: {
    // Provisions isolated, throwaway Postgres databases for the run — one per
    // worker slot — and drops them afterwards, so the suite never writes into a
    // shared/development database and cleans up after itself (GH #181, GH #14).
    // Requires DATABASE_URL.
    globalSetup: ["./vitest.global-setup.ts"],
    // GH #14. This used to be `fileParallelism: false`, because integration
    // tests shared one Postgres database and therefore one `sso_config`
    // singleton row (id = 1): concurrent beforeAll() calls stomped each other's
    // encrypted client secret and produced intermittent AES-GCM decrypt
    // failures. Serializing every file was a stopgap that made the whole suite
    // pay for one row.
    //
    // The sharing is gone instead: each worker slot gets its own database (see
    // vitest.global-setup.ts and src/infra/db/test-db.ts), which also closes
    // the two neighbours of that bug parallelism exposed — admin-users.test.ts
    // asserting a delta on aggregate user counts another file was moving, and
    // migrate.test.ts holding a database-wide advisory lock.
    //
    // Pinned rather than left to the CPU count: the databases are minted before
    // any worker exists, so the count has to be known up front. See
    // vitest.workers.ts.
    maxWorkers: TEST_WORKER_COUNT,
    minWorkers: 1,
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
      // The floor sits one notch under the worst-covered file measured today:
      //
      //   lines/statements  modules/profile/router.ts   90.00%
      //   branches          modules/ai/router.ts        71.15%
      //   functions         modules/auth/router.ts      50.00%
      //
      // Today's aggregate, for reference, is lines/statements 97.76%,
      // functions 97.04%, branches 88.95%.
      //
      // GH #245 re-measured all of this, because the numbers below had drifted
      // into meaning nothing. They were set to 55/35/60 while several agents
      // were editing at once, and the paragraph that justified them named
      // infra/db/migrate.ts "at 60% lines" — a file that measures 100% today,
      // and may well have by the time that sentence was written. A floor 35
      // points under the worst real file is not a ratchet: a new module could
      // land at 56% lines, pass the gate, and become the weakest file in the
      // package without anything objecting. The gap is now 3-5 points.
      //
      // The functions figure is the one to treat with care. It is set by
      // modules/auth/router.ts, and it is a LOWER bound rather than a
      // measurement: that file was being edited while this was measured, and
      // the edit stops one of its tests short — code that does not run counts
      // as uncovered. 45 leaves room for the real number to be higher, which
      // is the only direction it can be.
      //
      // A ratchet, not a target: raise these as the weakest files improve, and
      // close a gap by testing the file rather than by lowering the floor.
      thresholds: {
        perFile: true,
        lines: 85,
        statements: 85,
        functions: 45,
        branches: 68,
      },
    },
  },
});
