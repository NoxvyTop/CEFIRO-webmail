import { describe, expect, it } from "vitest";
import { composeTextBody, htmlToPlainText } from "./plainText";
import { QUOTE_MARKER_ATTR, SIGNATURE_MARKER_ATTR } from "./signature";

function quoted(inner: string, attribution = "<p>2026-07-01T10:00:00.000Z — Alice:</p>"): string {
  return `<div ${QUOTE_MARKER_ATTR}="true"><br><br>${attribution}<blockquote>${inner}</blockquote></div>`;
}

describe("htmlToPlainText", () => {
  it("turns block boundaries and <br> into newlines", () => {
    expect(htmlToPlainText("<p>uno</p><p>dos</p>")).toBe("uno\ndos");
    expect(htmlToPlainText("uno<br>dos")).toBe("uno\ndos");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToPlainText("")).toBe("");
  });

  it("drops machinery whose text is not message text", () => {
    const text = htmlToPlainText("<style>p{color:red}</style><script>alert(1)</script><p>hola</p>");
    expect(text).toBe("hola");
  });
});

// GH #141: the text/plain alternative used to be a naive tag strip, so the
// quoted conversation arrived indistinguishable from what the user had just
// written — no ">" markers, no separator, one continuous block.
describe("composeTextBody (GH #141)", () => {
  it("prefixes every quoted line with '> '", () => {
    const text = composeTextBody(`<p>Sure, works for me.</p>${quoted("<p>Line one</p><p>Line two</p>")}`);
    expect(text).toContain("> Line one");
    expect(text).toContain("> Line two");
  });

  it("keeps the attribution line unprefixed, directly above the quoted lines", () => {
    const text = composeTextBody(`<p>Reply</p>${quoted("<p>Original</p>")}`);
    const lines = text.split("\n");
    const attributionIndex = lines.findIndex((line) => line.includes("— Alice:"));
    expect(attributionIndex).toBeGreaterThanOrEqual(0);
    expect(lines[attributionIndex]).not.toMatch(/^>/);
    expect(lines[attributionIndex + 1]).toBe("> Original");
  });

  it("puts the user's new text first, separated from the quote by a blank line", () => {
    const text = composeTextBody(`<p>Sounds good.</p>${quoted("<p>Original</p>")}`);
    expect(text.startsWith("Sounds good.")).toBe(true);
    expect(text).toContain("Sounds good.\n\n2026-07-01T10:00:00.000Z — Alice:\n> Original");
  });

  it("marks a blank line inside the quote with a bare '>' so the quote stays visibly continuous", () => {
    const text = composeTextBody(quoted("<p>first</p><p></p><p>second</p>"));
    expect(text).toContain("> first\n>\n> second");
  });

  it("never leaves a quoted line unmarked", () => {
    const text = composeTextBody(`<p>New</p>${quoted("<p>a</p><p>b</p><p>c</p>")}`);
    const quotedLines = text.split("\n").slice(text.split("\n").findIndex((l) => l.includes("Alice:")) + 1);
    expect(quotedLines.length).toBeGreaterThan(0);
    for (const line of quotedLines) expect(line.startsWith(">")).toBe(true);
  });

  it("keeps the signature above the quote, unprefixed", () => {
    const html = `<p>Thanks</p><div ${SIGNATURE_MARKER_ATTR}="true"><p>-- Alice</p></div>${quoted("<p>Original</p>")}`;
    const text = composeTextBody(html);
    expect(text.indexOf("-- Alice")).toBeLessThan(text.indexOf("> Original"));
    expect(text).toContain("-- Alice");
    expect(text).not.toContain("> -- Alice");
  });

  it("falls back to a plain flatten when there is no quote (a brand-new mail)", () => {
    expect(composeTextBody("<p>Just a new message</p>")).toBe("Just a new message");
    expect(composeTextBody("")).toBe("");
  });

  it("prefixes the whole marked block when it carries no blockquote", () => {
    const text = composeTextBody(`<p>New</p><div ${QUOTE_MARKER_ATTR}="true"><p>Original</p></div>`);
    expect(text).toContain("> Original");
  });

  // The quoted original is untrusted markup, so it goes through the same
  // detached-document parse as everything else and its machinery never becomes
  // visible text.
  it("does not splice script/style source into the quoted text", () => {
    const text = composeTextBody(quoted("<style>p{color:red}</style><p>visible</p>"));
    expect(text).toContain("> visible");
    expect(text).not.toContain("color:red");
  });
});
