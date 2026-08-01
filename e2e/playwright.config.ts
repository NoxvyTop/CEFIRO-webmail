import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  BASE_DATABASE_URL_ENV,
  TEST_DATABASE_URL_ENV,
  requireBaseDatabaseUrl,
  uniqueDbName,
  withDatabase,
} from "./test-db";
import { IDP_ISSUER_ENV } from "./oidc-idp";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 8199);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

// A THROWAWAY key for this harness only, and it must stay identical to
// global-setup.ts's MASTER_KEY_B64 so the credentials it seeds (the mailbox
// password and the SSO client secret) are decryptable by both app servers
// below. It is a GENERATED key rather than the readable dev-compose one because
// these servers boot with NODE_ENV=production, which now refuses published or
// low-entropy keys (GH #223).
const MASTER_KEY = "JdJVpkA5AKBg+8w5V7XOqXnOXGuEgkybDHOvDiVYfJE=";

// GH #217: a second app server, identical to the one above except that
// BOOTSTRAP_MODE is OFF. The suite used to pin BOOTSTRAP_MODE=true for every
// run, which meant the production entry point — OIDC/SSO — was unreachable
// through the UI (LoginPage only offers the SSO button when /api/auth/mode
// reports bootstrapMode false) and never exercised end to end. Rather than
// choosing between the two modes for the whole suite, the OIDC spec gets its
// own server on its own port, with its own APP_URL so the callback it
// registers with the IdP is its own.
const SSO_PORT = Number(process.env.E2E_SSO_PORT ?? PORT + 1);
const SSO_BASE_URL = process.env.E2E_SSO_BASE_URL ?? `http://localhost:${SSO_PORT}`;
const SSO_CALLBACK_URL = `${SSO_BASE_URL}/api/auth/callback`;

// The test identity provider (oidc-idp.ts). Its issuer is published on
// process.env because global-setup.ts — loaded by this same runner process —
// seeds it into the encrypted sso_config row the server reads at login time.
const IDP_PORT = Number(process.env.E2E_IDP_PORT ?? PORT + 2);
const IDP_ISSUER = process.env[IDP_ISSUER_ENV] ?? `http://localhost:${IDP_PORT}`;
process.env[IDP_ISSUER_ENV] = IDP_ISSUER;

// GH #230. This used to default to postgres://…:5434/webmail — the shared
// *development* database — which the suite then migrated, wrote users/sessions/
// mail credentials into, and never cleaned up. There is no fallback now:
// DATABASE_URL must be set (requireBaseDatabaseUrl throws a loud, actionable
// error otherwise) and only ever serves as the admin connection from which a
// uniquely named sibling database is created for this run and dropped after it.
//
// The name is minted here rather than in global-setup.ts because Playwright
// starts `webServer` before globalSetup, so the URL has to be known while this
// config is being built. It is published on process.env so global-setup.ts —
// loaded by the same runner process — seeds and drops the exact database the
// app server is pointed at. Pre-setting it yourself opts out of the whole
// create/drop lifecycle (see test-db.ts).
const BASE_DATABASE_URL = requireBaseDatabaseUrl();
const DATABASE_URL =
  process.env[TEST_DATABASE_URL_ENV] ?? withDatabase(BASE_DATABASE_URL, uniqueDbName());
process.env[TEST_DATABASE_URL_ENV] = DATABASE_URL;

// Shared by both app servers; each one adds its own PORT, APP_URL and
// BOOTSTRAP_MODE on top.
const appServerEnv = {
  NODE_ENV: "production",
  STATIC_DIR: resolve(here, "../apps/web/dist"),
  DATABASE_URL,
  // The app server boots (and migrates) against DATABASE_URL above,
  // which is this run's throwaway database and does not exist yet —
  // Playwright starts webServer before globalSetup. serve.ts creates it
  // first, and needs a connectable admin URL to do so, which this is.
  [BASE_DATABASE_URL_ENV]: BASE_DATABASE_URL,
  MASTER_KEY,
  // Only pass STALWART_URL through when E2E_STALWART_URL is actually
  // set (no default here, mirroring global-setup.ts's raw env read).
  // Enables the mail router (apps/server/src/index.ts only creates the
  // JMAP client when config.stalwartUrl is set), so a default here
  // would make the router non-null even for non-mail runs where no
  // Stalwart fixture is running. Bring up the Stalwart fixture
  // separately before running mail specs:
  //   export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  //   docker compose -f docker-compose.e2e.yml up -d --build
  //
  // Explicitly EMPTY rather than simply omitted when there is no fixture: `bun`
  // auto-loads the repo-root .env into every process it starts, so a developer's
  // own STALWART_URL — pointing at a remote mail host, as the committed example
  // does — otherwise reaches the app server and quietly defeats the paragraph
  // above. It also makes /api/health probe that host, which degrades the
  // instance to 503 and leaves Playwright waiting on a `url` that never goes
  // ready. A real environment variable outranks .env, and core/config.ts reads
  // `env.STALWART_URL || undefined`, so "" is exactly "no mail backend".
  STALWART_URL: process.env.E2E_STALWART_URL ?? "",
};

// Quoted: Playwright hands `command` to a shell, so an unquoted path splits on
// its first space and the checkout only has to live under a directory such as
// "cefiro web" for the webServer to never start (GH #151).
const bun = (script: string) => `bun "${resolve(here, script)}"`;

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
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /oidc-login\.spec\.ts/,
    },
    {
      // The OIDC login flow drives the bootstrap-free server instead, and starts
      // from no session at all — it is the spec that creates one.
      name: "sso",
      testMatch: /oidc-login\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: SSO_BASE_URL,
        storageState: { cookies: [], origins: [] },
      },
    },
  ],
  // The build (vite) and serve (bun) steps are chained in `serve.ts` instead
  // of a shell `command` string here — `&&`/redirection syntax is not
  // portable across the shells Playwright may invoke (notably on Windows),
  // so a single Bun script spawns each step as a discrete child process.
  //
  // An externally supplied E2E_BASE_URL opts out of all three: the caller owns
  // the server, and is then also responsible for E2E_SSO_BASE_URL and
  // E2E_IDP_ISSUER if they want the OIDC spec to have anything to talk to.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          // Started first and independently: it holds no database or SPA state,
          // and both app servers can come up while it is still generating its
          // signing key.
          command: bun("idp-serve.ts"),
          cwd: resolve(here, ".."),
          url: `${IDP_ISSUER}/.well-known/openid-configuration`,
          timeout: 60_000,
          reuseExistingServer: !process.env.CI,
          env: {
            E2E_IDP_PORT: String(IDP_PORT),
            [IDP_ISSUER_ENV]: IDP_ISSUER,
            E2E_IDP_REDIRECT_URI: SSO_CALLBACK_URL,
          },
        },
        {
          command: bun("serve.ts"),
          cwd: resolve(here, ".."),
          url: `${BASE_URL}/api/health`,
          timeout: 120_000,
          reuseExistingServer: !process.env.CI,
          env: { ...appServerEnv, APP_URL: BASE_URL, PORT: String(PORT), BOOTSTRAP_MODE: "true" },
        },
        {
          command: bun("serve.ts"),
          cwd: resolve(here, ".."),
          url: `${SSO_BASE_URL}/api/health`,
          timeout: 120_000,
          reuseExistingServer: !process.env.CI,
          env: {
            ...appServerEnv,
            APP_URL: SSO_BASE_URL,
            PORT: String(SSO_PORT),
            BOOTSTRAP_MODE: "false",
            // Playwright starts every webServer at once, but these two share one
            // database and one apps/web/dist. Waiting for the first means this
            // one neither races it to CREATE DATABASE nor rebuilds the SPA.
            E2E_WAIT_FOR: `${BASE_URL}/api/health`,
            E2E_SKIP_BUILD: "1",
          },
        },
      ],
});
