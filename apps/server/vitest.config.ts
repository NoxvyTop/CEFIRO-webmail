import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one Postgres instance and a singleton
    // sso_config row (id = 1). Running test files in parallel lets
    // concurrent beforeAll() calls stomp each other's encrypted
    // client secret, causing intermittent AES-GCM decrypt failures.
    // Serialize file execution to keep the shared row consistent.
    fileParallelism: false,
  },
});
