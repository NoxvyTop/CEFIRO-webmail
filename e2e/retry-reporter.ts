import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig, Reporter, Suite, TestCase } from "@playwright/test/reporter";

/**
 * Makes Playwright's retries visible — GH #246.
 *
 * `retries: 1` on CI is a deliberate tolerance for genuine infrastructure
 * noise, but on its own it is also a silencer: the `github` reporter annotates
 * a spec that only passed on its second attempt, the job still exits 0, and
 * nobody counts. A spec that fails half the time then looks exactly like a
 * healthy one, forever, because nothing in the pipeline ever writes the number
 * down. That is how the composer flake survived — one unstable spec is enough
 * to make "the suite is green" stop meaning anything.
 *
 * This reporter does not change the verdict; changing it would trade a silent
 * flake for a pipeline blocked by the first bad DNS lookup. It makes the fact
 * durable instead, on three surfaces with different lifetimes:
 *
 *   - the job log (`::warning::`), which is what a human reads first;
 *   - the job summary, which stays on the run page after the log scrolls;
 *   - a JSON artifact, the only one a script can aggregate across runs — the
 *     form the policy in e2e/README.md needs in order to be enforceable.
 *
 * See that README for what is expected to HAPPEN when a spec shows up here
 * repeatedly. A record nobody acts on is the same silence with extra steps.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/**
 * Written under Playwright's own `outputDir`, which is already gitignored and
 * — importantly — is cleaned BEFORE the run rather than after it, so a file
 * written at `onEnd` survives. The HTML reporter's directory would not: it
 * rewrites its output folder when it renders, and reporter ordering is not a
 * contract worth depending on.
 */
const REPORT_PATH = resolve(here, "test-results/retries.json");

/**
 * The SGR sequences Playwright colours its error messages with. Built from a
 * char code rather than written as an escape so this regex carries no literal
 * control character (see biome.jsonc's note on noControlCharactersInRegex).
 */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type RetriedTest = {
  /** Repo-relative "file:line", the shape an issue or a grep wants. */
  location: string;
  title: string;
  project: string;
  /** Attempts in total: 1 + the number of retries this spec consumed. */
  attempts: number;
  /**
   * `flaky` — failed, then passed on a retry: a green job hiding a real defect.
   * `failed` — exhausted its retries; the job is already red and says so.
   */
  outcome: "flaky" | "failed";
  /** First failure message, one line — enough to group repeats by cause. */
  firstError: string | undefined;
};

type RetryReport = {
  /** Whether the run even allowed retries; a 0-retry run proves nothing here. */
  retries: number;
  totalTests: number;
  flaky: number;
  failed: number;
  tests: RetriedTest[];
};

function firstErrorMessage(test: TestCase): string | undefined {
  const message = test.results.find((result) => result.error)?.error?.message;
  if (!message) return undefined;
  // The first line is what identifies the failure; the diff below it belongs
  // in the HTML report, not in a summary table.
  return message.replace(ANSI_SGR, "").split("\n")[0]?.trim();
}

function markdownSummary(report: RetryReport): string {
  const rows = report.tests
    .map(
      (test) =>
        `| ${test.outcome} | \`${test.location}\` | ${test.title} | ${test.project} | ${test.attempts} | ${test.firstError ?? ""} |`,
    )
    .join("\n");
  return [
    "### e2e retries",
    "",
    `${report.flaky} flaky, ${report.failed} failed after retrying, out of ${report.totalTests} tests.`,
    "",
    "| outcome | spec | test | project | attempts | first failure |",
    "| --- | --- | --- | --- | --- | --- |",
    rows,
    "",
    "A spec that appears here across separate commits gets fixed or quarantined, never left retrying — see `e2e/README.md`.",
    "",
  ].join("\n");
}

export default class RetryReporter implements Reporter {
  private suite: Suite | undefined;
  private retries = 0;

  onBegin(config: FullConfig, suite: Suite): void {
    this.suite = suite;
    // `projects[0]` is representative: this suite declares `retries` once at
    // the top level, so every project inherits the same number.
    this.retries = config.projects[0]?.retries ?? 0;
  }

  async onEnd(): Promise<void> {
    const allTests = this.suite?.allTests() ?? [];
    const tests: RetriedTest[] = allTests
      // `results.length > 1` is the retry itself, not the verdict: it catches a
      // spec that recovered (flaky) AND one that never did, and it is the only
      // signal that survives a run whose overall status is "passed".
      .filter((test) => test.results.length > 1)
      .map((test) => ({
        location: `${relative(repoRoot, test.location.file).replaceAll("\\", "/")}:${test.location.line}`,
        title: test.title,
        // titlePath() is ['', <project>, <file>, ...describes, <title>]; the
        // project is what distinguishes the same file run against the default
        // server from one run against the `sso` or `setup` server.
        project: test.titlePath()[1] ?? "",
        attempts: test.results.length,
        outcome: test.outcome() === "flaky" ? "flaky" : "failed",
        firstError: firstErrorMessage(test),
      }));

    const report: RetryReport = {
      retries: this.retries,
      totalTests: allTests.length,
      flaky: tests.filter((test) => test.outcome === "flaky").length,
      failed: tests.filter((test) => test.outcome === "failed").length,
      tests,
    };

    // Written unconditionally, including the empty case: an artifact that only
    // appears when something went wrong cannot be told apart from an artifact
    // whose upload failed, and "zero flakes this run" is itself the datum the
    // policy tracks over time.
    await mkdir(dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

    if (tests.length === 0) return;

    for (const test of tests) {
      // A workflow command, so each retry also lands on the run's annotations
      // rather than only in the scrollback.
      process.stdout.write(
        `::warning file=${test.location},title=Retried e2e spec::${test.title} (${test.project}) needed ${test.attempts} attempts and ended ${test.outcome}\n`,
      );
    }

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) await appendFile(summaryPath, markdownSummary(report));
  }
}
