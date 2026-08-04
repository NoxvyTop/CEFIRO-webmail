import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #283. The e2e suite (e2e/tests/theme-contrast.spec.ts) verifies theme.css's
// contrast ratios against a real browser, but that needs Playwright and does not
// run in `bun run test`. This is the fast, in-suite guard for the one pair #283
// is about: the SOLID CTA (bg-accent + text-accent-ink) is normal-size text and
// must clear WCAG AA 4.5:1 in BOTH themes. It reads the authored hex values
// straight out of theme.css so a re-tune that drops either below the bar fails
// here immediately, without waiting for a browser. Read from disk (Vitest runs
// with the package root as cwd) and normalized to \n so the block scan below is
// line-ending agnostic; import.meta.url is an http:// URL under Vite, and a
// `?raw` import is intercepted by the CSS plugin, so neither locates the source.
const css = readFileSync(resolve(process.cwd(), "src/app/theme.css"), "utf8").replaceAll(
  "\r\n",
  "\n",
);

/** The declarations between a selector's `{` and its closing `}`. */
function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const braceStart = css.indexOf("{", start);
  const braceEnd = css.indexOf("\n}", braceStart);
  return css.slice(braceStart, braceEnd);
}

/** The 6-digit hex value of a custom property within a block. */
function hex(source: string, token: string): [number, number, number] {
  const match = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(source);
  if (!match) throw new Error(`${token} not found`);
  const value = match[1]!;
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = luminance(a) >= luminance(b) ? [a, b] : [b, a];
  return (luminance(hi) + 0.05) / (luminance(lo) + 0.05);
}

// The night tokens live in the shared `:root,` block; light overrides them.
const THEMES = {
  night: block(":root,"),
  light: block(':root[data-theme="light"]'),
} as const;

describe("theme.css solid CTA contrast (#283)", () => {
  for (const [name, source] of Object.entries(THEMES)) {
    it(`accent-ink on accent clears WCAG AA (4.5:1) in the ${name} theme`, () => {
      const ratio = contrast(hex(source, "--accent-ink"), hex(source, "--accent"));
      expect(ratio, `${name}: accent-ink on accent is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    });
  }
});
