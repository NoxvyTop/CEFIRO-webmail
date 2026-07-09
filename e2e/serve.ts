// Builds the web SPA and starts the production server as a single portable
// command for Playwright's `webServer`. Avoids shell `&&`/redirection chains,
// which are not reliably portable across Windows/macOS/Linux shells — each
// step below is a single spawned command instead.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "../apps/web");
const serverEntry = resolve(here, "../apps/server/src/index.ts");

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
