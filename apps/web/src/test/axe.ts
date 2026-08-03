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
 *   verify them — which e2e/tests/theme-contrast.spec.ts now does (GH #280).
 * - The `region` / landmark family judges a whole PAGE. A per-screen run mounts
 *   one component, so its content legitimately sits outside the app shell
 *   landmarks that App.tsx provides around it in the real document — so
 *   expectNoAxeViolations leaves them off. The SHELL, however, IS that full
 *   page: it owns the skip link and the single <main> (GH #200), which is the
 *   one place those rules can pass. expectNoShellAxeViolations turns them back
 *   on so #200's structure is actually asserted rather than assumed (GH #280).
 */
const LAYOUT_DEPENDENT_RULES = ["color-contrast"];

// Landmark/region rules judge a whole PAGE. expectNoAxeViolations mounts one
// component that legitimately sits outside the shell landmarks, so these stay
// off there; expectNoShellAxeViolations re-enables them over the full shell.
const SHELL_LANDMARK_RULES = ["region", "landmark-one-main", "bypass"];

// A page should have exactly one <h1>. That is a property of the ROUTE content
// rendered into the shell's <main>, not of the shell chrome (whose Outlet may
// still be showing its Suspense fallback), so it stays off even for the shell.
const ROUTE_CONTENT_RULES = ["page-has-heading-one"];

function disabled(rules: string[]): RunOptions["rules"] {
  return Object.fromEntries(rules.map((rule) => [rule, { enabled: false }]));
}

async function runAxe(context: ElementContext, disabledRules: string[]): Promise<Result[]> {
  const results = await axe.run(context, {
    rules: disabled(disabledRules),
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

function describeViolation(violation: Result): string {
  const nodes = violation.nodes
    .map((node) => `      ${node.html}\n        ${node.failureSummary ?? ""}`)
    .join("\n");
  return `  [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n${nodes}`;
}

/**
 * Fails with the violating markup inline, so a regression names the element
 * rather than only the rule.
 */
function expectClean(violations: Result[]): void {
  const report = violations.map(describeViolation).join("\n");
  expect(report, `axe found ${violations.length} violation(s):\n${report}`).toBe("");
}

/** The raw violation list, for tests that assert something ABOUT a known one. */
export async function axeViolations(
  context: ElementContext,
  extraDisabledRules: string[] = [],
): Promise<Result[]> {
  return runAxe(context, [
    ...LAYOUT_DEPENDENT_RULES,
    ...SHELL_LANDMARK_RULES,
    ...ROUTE_CONTENT_RULES,
    ...extraDisabledRules,
  ]);
}

/**
 * Per-screen accessibility check for feature components. The landmark/region
 * family stays off (see SHELL_LANDMARK_RULES) because these are not full pages.
 *
 * `extraDisabledRules` exists for a screen with a known, documented and
 * separately-pinned exception — never as a way to make a fresh failure go away.
 */
export async function expectNoAxeViolations(
  context: ElementContext,
  extraDisabledRules: string[] = [],
): Promise<void> {
  expectClean(await axeViolations(context, extraDisabledRules));
}

/**
 * Full-page accessibility check for the mounted app SHELL. Unlike the per-screen
 * helper above, the landmark/region family runs here: the shell is the whole
 * page, so `bypass` (skip link), `landmark-one-main` (single <main>) and
 * `region` (all content within a landmark) are exactly what it must satisfy —
 * the GH #200 structure that nothing verified before (GH #280). Only
 * `color-contrast` (jsdom paints nothing — verified in a browser by
 * theme-contrast.spec.ts) and `page-has-heading-one` (route content, not the
 * shell chrome) stay off.
 */
export async function expectNoShellAxeViolations(context: ElementContext): Promise<void> {
  expectClean(await runAxe(context, [...LAYOUT_DEPENDENT_RULES, ...ROUTE_CONTENT_RULES]));
}
