import axe, { type ElementContext, type RunOptions, type Result } from "axe-core";
import { expect } from "vitest";

/**
 * GH #252: the repo had no automated accessibility check of any kind — the
 * closest thing was a handful of hand-written assertions in
 * message-list.test.tsx that spelled out, by hand, two rules an axe run
 * reports on its own. This runs the real engine over a rendered screen.
 *
 * Rules that cannot produce a meaningful answer without layout are turned off
 * rather than left to report noise:
 *
 * - `color-contrast` needs computed pixel colors, and jsdom paints nothing.
 *   Contrast is a stylesheet property anyway; theme.css carries the measured
 *   ratios (see the --warn note there) and a browser is the only place to
 *   verify them.
 * - The `region` / landmark family judges a whole PAGE. These runs mount one
 *   screen's component, so its content legitimately sits outside the app shell
 *   landmarks that App.tsx provides around it in the real document.
 */
const LAYOUT_DEPENDENT_RULES = ["color-contrast"];
const PAGE_LEVEL_RULES = ["region", "landmark-one-main", "page-has-heading-one", "bypass"];

function disabled(rules: string[]): RunOptions["rules"] {
  return Object.fromEntries(rules.map((rule) => [rule, { enabled: false }]));
}

function describeViolation(violation: Result): string {
  const nodes = violation.nodes
    .map((node) => `      ${node.html}\n        ${node.failureSummary ?? ""}`)
    .join("\n");
  return `  [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n${nodes}`;
}

/** The raw violation list, for tests that assert something ABOUT a known one. */
export async function axeViolations(
  context: ElementContext,
  extraDisabledRules: string[] = [],
): Promise<Result[]> {
  const results = await axe.run(context, {
    rules: disabled([...LAYOUT_DEPENDENT_RULES, ...PAGE_LEVEL_RULES, ...extraDisabledRules]),
    resultTypes: ["violations"],
    // The reader renders message bodies inside a sandboxed <iframe>. axe
    // descends into frames by injecting itself and talking to them over
    // postMessage, which jsdom cannot complete ("Respondable target must be a
    // frame in the current window") — so the whole run throws instead of
    // reporting anything. The frame's content is remote HTML this app
    // sanitizes rather than authors, so it is not what these runs are about.
    iframes: false,
  });
  return results.violations;
}

/**
 * Fails with the violating markup inline, so a regression names the element
 * rather than only the rule.
 *
 * `extraDisabledRules` exists for a screen with a known, documented and
 * separately-pinned exception — never as a way to make a fresh failure go away.
 */
export async function expectNoAxeViolations(
  context: ElementContext,
  extraDisabledRules: string[] = [],
): Promise<void> {
  const violations = await axeViolations(context, extraDisabledRules);

  const report = violations.map(describeViolation).join("\n");
  expect(report, `axe found ${violations.length} violation(s):\n${report}`).toBe("");
}
