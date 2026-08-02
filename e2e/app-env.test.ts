import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ENV_FILE, bunArgs, bunCommand } from "./app-env";

// GH #231. `bun` auto-loads the `.env` of its working directory, and this
// harness runs its servers from the repository root — so a developer's own
// `.env` reached the app server under test. It happened for real: STALWART_URL
// pointed at a remote mail host, /api/health degraded to 503, and Playwright
// waited out its 120s without a single spec running. Only the variables
// playwright.config.ts happened to set by hand were safe.
//
// The fix is one flag on every `bun` the harness starts, which is exactly the
// kind of thing that is quietly dropped in a later edit and only noticed on the
// machine where it matters. So the flag is asserted, and — because the flag is
// worth nothing if `--env-file` ever stopped REPLACING the auto-load — so is
// the behaviour it depends on.

// The three tests below each start a real `bun`, which is the only way to
// observe an auto-load that happens before any of our code runs. Well past
// bun:test's 5s default: a cold process start under coverage instrumentation
// measured ~8s, and this must not become the suite's flaky test.
const SPAWN_TIMEOUT_MS = 30_000;

/** A directory holding a `.env` a leaked variable could only have come from. */
function projectWithEnvFile(): { dir: string; script: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "e2e-env-leak-"));
  writeFileSync(join(dir, ".env"), "E2E_LEAK_PROBE=leaked\n");
  const script = join(dir, "probe.ts");
  writeFileSync(script, 'console.log(process.env.E2E_LEAK_PROBE ?? "<unset>");\n');
  return { dir, script, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runBun(args: string[], cwd: string): string {
  const result = spawnSync("bun", args, { cwd, encoding: "utf8", shell: true });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

test("the pinned env file declares nothing", () => {
  // An assignment here would be a variable reaching the servers under test from
  // outside playwright.config.ts, which is the whole problem restated.
  const meaningful = readFileSync(APP_ENV_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  expect(meaningful).toEqual([]);
});

test("both spawn helpers pin the env file", () => {
  expect(bunCommand("/some/script.ts")).toBe(
    `bun --env-file="${APP_ENV_FILE}" "/some/script.ts"`,
  );
  // serve.ts spawns the app server as a second, fresh bun process that does its
  // own auto-load — pinning only the outer one would leave the leak open.
  expect(bunArgs("/some/script.ts")).toEqual([
    `--env-file="${APP_ENV_FILE}"`,
    '"/some/script.ts"',
  ]);
});

test("a .env in the working directory reaches an unpinned bun process", () => {
  // The control. Without it, the assertion below could pass because the probe
  // never worked rather than because the pin does.
  const project = projectWithEnvFile();
  try {
    expect(runBun([`"${project.script}"`], project.dir)).toBe("leaked");
  } finally {
    project.cleanup();
  }
}, SPAWN_TIMEOUT_MS);

test("the pinned env file replaces that auto-load rather than adding to it", () => {
  const project = projectWithEnvFile();
  try {
    expect(runBun(bunArgs(project.script), project.dir)).toBe("<unset>");
  } finally {
    project.cleanup();
  }
}, SPAWN_TIMEOUT_MS);

test("a variable the harness sets explicitly still outranks the pin", () => {
  // The pin must not be so total that playwright.config.ts's own env blocks
  // stop working: a real environment variable has to keep winning.
  const project = projectWithEnvFile();
  try {
    const result = spawnSync("bun", bunArgs(project.script), {
      cwd: project.dir,
      encoding: "utf8",
      shell: true,
      env: { ...process.env, E2E_LEAK_PROBE: "set-by-the-harness" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("set-by-the-harness");
  } finally {
    project.cleanup();
  }
}, SPAWN_TIMEOUT_MS);
