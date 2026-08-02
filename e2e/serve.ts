// Builds the web SPA and starts the production server as a single portable
// command for Playwright's `webServer`. Avoids shell `&&`/redirection chains,
// which are not reliably portable across Windows/macOS/Linux shells — each
// step below is a single spawned command instead.
//
// The suite runs this twice (GH #217): once for the default app server, and
// once more for the SSO server, which is the same binary with BOOTSTRAP_MODE
// off so the OIDC login path can be exercised without the break-glass form
// standing in for it. The two are chained rather than raced — see E2E_WAIT_FOR
// below — because they share one database and one SPA build.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { bunArgs } from "./app-env";
import { BASE_DATABASE_URL_ENV, createTestDatabase, isThrowawayDatabase } from "./test-db";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "../apps/web");
const serverEntry = resolve(here, "../apps/server/src/index.ts");

const WAIT_FOR_ATTEMPTS = 240;
const WAIT_FOR_DELAY_MS = 500;

/**
 * Blocks until `url` answers, so a second instance of this script starts only
 * after the first one is serving.
 *
 * Serialization is the point, not politeness. Both instances create the run's
 * throwaway database and both migrate it at boot; concurrent CREATE DATABASE
 * from the same template can fail outright, and while migrate() is advisory-
 * locked (infra/db/migrate.ts) there is no reason to make the second server
 * wait on a lock when waiting on a health check is exact. Any HTTP answer
 * counts — the first server being reachable is the only fact needed here.
 */
async function waitForServer(url: string): Promise<void> {
  for (let attempt = 1; attempt <= WAIT_FOR_ATTEMPTS; attempt += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      if (attempt === WAIT_FOR_ATTEMPTS) {
        throw new Error(
          `timed out waiting for ${url} after ${WAIT_FOR_ATTEMPTS} attempts — ` +
            "the app server this one chains behind never came up.",
        );
      }
      await new Promise((r) => setTimeout(r, WAIT_FOR_DELAY_MS));
    }
  }
}

const waitFor = process.env.E2E_WAIT_FOR;
if (waitFor) await waitForServer(waitFor);

// The run's throwaway database (GH #230) has to exist before the server below
// starts: apps/server/src/index.ts connects and migrates on boot, and Playwright
// runs `webServer` as a plugin *before* globalSetup, so global-setup.ts is too
// late to be the only creator. Guarded on the name being a throwaway one, so a
// caller who pinned E2E_DATABASE_URL at a database they own gets it left alone.
const testDatabaseUrl = process.env.DATABASE_URL;
const baseDatabaseUrl = process.env[BASE_DATABASE_URL_ENV];
if (testDatabaseUrl && baseDatabaseUrl && isThrowawayDatabase(testDatabaseUrl)) {
  await createTestDatabase(baseDatabaseUrl, testDatabaseUrl);
}

// Skipped by the chained SSO server: both serve the same apps/web/dist, and the
// instance it waited for above has already built it.
if (process.env.E2E_SKIP_BUILD !== "1") {
  const build = spawnSync("bunx", ["vite", "build"], {
    cwd: webDir,
    stdio: "inherit",
    shell: true,
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

// Quoting: `shell: true` hands the argument list to a shell verbatim, so an
// unquoted path splits on the first space and `bun` is asked to run a file that
// does not exist — the checkout only has to live under a directory such as
// "cefiro web" for that to happen (GH #151).
//
// The env-file pin (GH #231) has to be repeated here, not just on the outer
// script: this is a FRESH `bun` process, so it performs its own auto-load of
// the repository root's `.env` and would inherit every variable playwright's
// config does not set explicitly — which is how a developer's STALWART_URL
// ended up reconfiguring the server under test. See app-env.ts.
const server = spawn("bun", bunArgs(serverEntry), {
  stdio: "inherit",
  env: process.env,
  shell: true,
});
server.on("exit", (code) => process.exit(code ?? 0));
