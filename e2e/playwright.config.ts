import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 8199);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    storageState: resolve(here, ".auth/state.json"),
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The build (vite) and serve (bun) steps are chained in `serve.ts` instead
  // of a shell `command` string here — `&&`/redirection syntax is not
  // portable across the shells Playwright may invoke (notably on Windows),
  // so a single Bun script spawns each step as a discrete child process.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `bun ${resolve(here, "serve.ts")}`,
        cwd: resolve(here, ".."),
        url: `${BASE_URL}/api/health`,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
        env: {
          NODE_ENV: "production",
          STATIC_DIR: resolve(here, "../apps/web/dist"),
          DATABASE_URL,
          MASTER_KEY: "ZGV2LW1hc3Rlci1rZXktZGV2LW1hc3Rlci1rZXktMDE=",
          APP_URL: BASE_URL,
          PORT: String(PORT),
          BOOTSTRAP_MODE: "true",
          // Only pass STALWART_URL through when E2E_STALWART_URL is actually
          // set (no default here, mirroring global-setup.ts's raw env read).
          // Enables the mail router (apps/server/src/index.ts only creates the
          // JMAP client when config.stalwartUrl is set), so a default here
          // would make the router non-null even for non-mail runs where no
          // Stalwart fixture is running. Bring up the Stalwart fixture
          // separately before running mail specs:
          //   export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
          //   docker compose -f docker-compose.e2e.yml up -d --build
          ...(process.env.E2E_STALWART_URL ? { STALWART_URL: process.env.E2E_STALWART_URL } : {}),
        },
      },
});
