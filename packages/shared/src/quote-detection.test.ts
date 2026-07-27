import { describe, expect, it } from "vitest";
import { isQuoteSeparatorLine } from "./quote-detection";

// GH #168: this rule used to be reimplemented independently by the server
// (apps/server/src/modules/ai/router.ts, for AI-summary quote stripping) and
// the web client (apps/web/src/features/reader/EmailBody.tsx, for the reader's
// plain-text quote split) — and the two had already drifted apart: the
// client's Gmail-separator pattern lacked the `i` flag the server's had, and
// the client's Outlook banner pattern required exactly one literal space
// where the server accepted any run of whitespace. This is now the single
// source of truth both sides import, so a case/whitespace variant either
// both sides split on, or neither does.
describe("isQuoteSeparatorLine", () => {
  it("matches the Spanish Gmail separator regardless of case", () => {
    expect(isQuoteSeparatorLine("El 5 de mayo, Ana escribió:")).toBe(true);
    // Lowercase "el" — this is the exact case that diverged between the
    // server (matched, case-insensitive) and the client (missed, no `i` flag).
    expect(isQuoteSeparatorLine("el 5 de mayo, Ana escribió:")).toBe(true);
    expect(isQuoteSeparatorLine("EL 5 DE MAYO, ANA ESCRIBIÓ:")).toBe(true);
  });

  it("matches the English Gmail separator regardless of case", () => {
    expect(isQuoteSeparatorLine("On Mon, Jul 20, 2026 at 10:00 AM John Doe wrote:")).toBe(true);
    expect(isQuoteSeparatorLine("on mon, jul 20, 2026 at 10:00 am john doe wrote:")).toBe(true);
  });

  it("matches an Outlook '-----Original Message-----' banner with a single space between words", () => {
    expect(isQuoteSeparatorLine("-----Original Message-----")).toBe(true);
  });

  it("matches an Outlook banner with extra internal whitespace between 'Original' and 'Message'", () => {
    // Two spaces — this is the exact case that diverged: the server's \s+
    // matched it, the client's literal single space did not.
    expect(isQuoteSeparatorLine("-----Original  Message-----")).toBe(true);
    expect(isQuoteSeparatorLine("-----original message-----")).toBe(true);
  });

  it("matches an Outlook underscore divider of 8 or more underscores", () => {
    expect(isQuoteSeparatorLine("________________________________")).toBe(true);
  });

  it("does not match a divider shorter than 8 underscores", () => {
    expect(isQuoteSeparatorLine("_______")).toBe(false);
  });

  it("does not match ordinary prose, including a line that merely contains 'wrote' or 'escribió'", () => {
    expect(isQuoteSeparatorLine("I wrote this yesterday.")).toBe(false);
    expect(isQuoteSeparatorLine("Ya te había escribió algo distinto.")).toBe(false);
    expect(isQuoteSeparatorLine("Just a normal line of text.")).toBe(false);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(isQuoteSeparatorLine("   On Mon, Jul 20, 2026 John Doe wrote:   ")).toBe(true);
  });
});
