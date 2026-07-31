import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/index.ts"],
      // Thresholds sit just under today's measured coverage (statements/lines
      // 95.04%, functions 94.19%, branches 86.26%), floored to fives so the gate
      // is green now but a genuine regression trips it. A ratchet floor, not a
      // target — raise it as coverage climbs.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
