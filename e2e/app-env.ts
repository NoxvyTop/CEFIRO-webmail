import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The assignment-free env file every `bun` process this harness starts is
 * pinned to (GH #231). See app-server.env for the reasoning; in short, `bun`
 * auto-loads the `.env` of its working directory and the harness runs from the
 * repository root, so a developer's own `.env` was reconfiguring the very
 * server under test.
 *
 * `--env-file` REPLACES that auto-load rather than adding to it (verified
 * against bun 1.3), which is what makes an empty file a complete answer: a real
 * environment variable — everything playwright.config.ts sets explicitly — is
 * unaffected, and nothing else gets in.
 */
export const APP_ENV_FILE = resolve(here, "app-server.env");

/**
 * The command line for a harness script, with the env-file pin already applied.
 *
 * Both arguments are quoted because Playwright hands `command` to a shell and
 * `serve.ts` spawns with `shell: true`: an unquoted path splits on its first
 * space, and the checkout only has to live under a directory such as
 * "cefiro web" for the server to never start (GH #151).
 */
export function bunCommand(scriptPath: string): string {
  return `bun --env-file="${APP_ENV_FILE}" "${scriptPath}"`;
}

/**
 * The argv `serve.ts` spawns the app server with — the same pin, one level
 * down. Pinning only the outer script would leave the leak wide open: `serve.ts`
 * spawns `apps/server/src/index.ts` as a fresh `bun` process, which does its own
 * auto-load from the same working directory.
 */
export function bunArgs(scriptPath: string): string[] {
  return [`--env-file="${APP_ENV_FILE}"`, `"${scriptPath}"`];
}
