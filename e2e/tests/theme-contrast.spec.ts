import { expect, test } from "@playwright/test";

// GH #280. apps/web/src/app/theme.css annotates almost every token with a
// measured WCAG contrast ratio (CLARO-02/-04/-11, OM-3, #173a, …), but nothing
// ever verified those numbers: the unit-side axe run disables `color-contrast`
// because jsdom paints no pixels, so the ratios were comments, not assertions.
//
// This asserts them against a REAL browser — the only place contrast can be
// computed — in both themes, using the browser's own resolution of the CSS
// custom properties (so color-mix/hex/rgb all reduce to concrete pixels).
//
// The floors are the WCAG thresholds each comment TARGETS, not the exact
// measured values: 4.5:1 for tokens used as normal text, 3:1 for non-text UI
// (boundary lines, standalone icons). A deliberate re-tune that stays above the
// bar therefore does not turn this red; a regression that drops a token below
// its threshold does.

type Pair = { name: string; fg: string; bg: string; min: number };

// Token pairs exactly as authored/annotated in theme.css. `fg` is the token
// under test; `bg` is the surface it actually sits on in the product.
const PAIRS: Pair[] = [
  // Foundational readable-text guarantees.
  { name: "ink on canvas", fg: "--ink", bg: "--bg", min: 4.5 },
  { name: "ink on panel", fg: "--ink", bg: "--panel", min: 4.5 },
  { name: "muted on panel", fg: "--muted", bg: "--panel", min: 4.5 },
  // NOTE — the solid CTA pair (--accent-ink on --accent) is deliberately NOT
  // asserted here. theme.css makes no contrast claim for it: light's --accent
  // (#0fa383) with white --accent-ink measures ~3.19:1, which is why the design
  // ships a SEPARATE text-safe token, --accent-text (#0a725c, CLARO-02),
  // asserted below. Whether the solid mint CTA fill itself needs a darker ink
  // is a design-token question outside GH #280 (which is about the annotated
  // ratios going unverified) and outside this spec's ownership.
  // CLARO-02: accent used AS TEXT, over every surface it lands on. Light's
  // --accent-text was tuned against --sel (the darkest of the three), so all
  // three are asserted.
  { name: "accent-text on panel", fg: "--accent-text", bg: "--panel", min: 4.5 },
  { name: "accent-text on soft", fg: "--accent-text", bg: "--soft", min: 4.5 },
  { name: "accent-text on sel", fg: "--accent-text", bg: "--sel", min: 4.5 },
  // OM-3: --warn used as text (the unlinked-mailbox notice).
  { name: "warn on panel", fg: "--warn", bg: "--panel", min: 4.5 },
  // CLARO-11: --star as a standalone icon/label — non-text 3:1.
  { name: "star on panel", fg: "--star", bg: "--panel", min: 3 },
  // CLARO-04 / #173a: --line-strong for interactive/UI boundaries — non-text 3:1.
  { name: "line-strong on panel", fg: "--line-strong", bg: "--panel", min: 3 },
];

for (const theme of ["night", "light"] as const) {
  test(`theme.css tokens meet their WCAG contrast floors (${theme})`, async ({ page }) => {
    await page.goto("/");

    const results = await page.evaluate(
      ({ theme, pairs }) => {
        document.documentElement.dataset.theme = theme;

        // Resolve a token (or literal color) to concrete sRGB by letting the
        // browser compute it, so var()/color-mix/hex all reduce to "rgb(r,g,b)".
        function resolve(value: string): [number, number, number] {
          const probe = document.createElement("span");
          probe.style.color = value.startsWith("--") ? `var(${value})` : value;
          document.body.appendChild(probe);
          const computed = getComputedStyle(probe).color;
          probe.remove();
          const match = computed.match(/-?\d+(?:\.\d+)?/g);
          if (!match || match.length < 3) {
            throw new Error(`could not resolve ${value} (got "${computed}")`);
          }
          return [Number(match[0]), Number(match[1]), Number(match[2])];
        }

        function luminance([r, g, b]: [number, number, number]): number {
          const channel = (v: number) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        }

        function contrast(a: [number, number, number], b: [number, number, number]): number {
          const la = luminance(a);
          const lb = luminance(b);
          const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
          return (hi + 0.05) / (lo + 0.05);
        }

        return pairs.map((pair) => ({
          name: pair.name,
          min: pair.min,
          ratio: contrast(resolve(pair.fg), resolve(pair.bg)),
        }));
      },
      { theme, pairs: PAIRS },
    );

    for (const result of results) {
      expect(
        result.ratio,
        `${theme}: "${result.name}" contrast ${result.ratio.toFixed(2)}:1 must clear ${result.min}:1`,
      ).toBeGreaterThanOrEqual(result.min);
    }
  });
}
