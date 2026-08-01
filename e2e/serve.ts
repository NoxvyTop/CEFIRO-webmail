// Builds the web SPA and starts the production server as a single portable
// command for Playwright's `webServer`. Avoids shell `&&`/redirection chains,
// which are not reliably portable across Windows/macOS/Linux shells — each
// step below is a single spawned command instead.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BASE_DATABASE_URL_ENV, createTestDatabase, isThrowawayDatabase } from "./test-db";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "../apps/web");
const serverEntry = resolve(here, "../apps/server/src/index.ts");

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

const build = spawnSync("bunx", ["vite", "build"], {
  cwd: webDir,
  stdio: "inherit",
  shell: true,
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const server = spawn("bun", [serverEntry], {
  stdio: "inherit",
  env: process.env,
  shell: true,
});
server.on("exit", (code) => process.exit(code ?? 0));
