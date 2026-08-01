import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { MarkerBlock } from "./markerBlockExtension";
import { joinQuotedTail, splitQuotedTail } from "./quoteSplit";
import { QUOTE_MARKER_ATTR, SIGNATURE_MARKER_ATTR } from "./signature";

const INVOICE_TABLE =
  '<table style="width:100%"><tbody><tr><td>Item</td><td>Total</td></tr>' +
  "<tr><td>Consulting</td><td>1200</td></tr></tbody></table>";

function quoteBlock(inner: string): string {
  return `<div ${QUOTE_MARKER_ATTR}="true"><br><br><p>2026-07-01 — Alice:</p><blockquote>${inner}</blockquote></div>`;
}

// The exact schema RichTextEditor parses against, minus the extensions that
// play no part in structural preservation. This is the mechanism under test in
// the first block: what the editor does to markup it has no node for.
function editorRoundTrip(html: string): string {
  const editor = new Editor({ extensions: [StarterKit, MarkerBlock], content: html });
  try {
    return editor.getHTML();
  } finally {
    editor.destroy();
  }
}

// GH #142. Pinning the failure mode itself, not just the fix: if a future
// schema change makes the editor able to carry tables, these tests say so
// loudly rather than quietly justifying a workaround that is no longer needed.
describe("editor schema flattening (GH #142)", () => {
  it("destroys quoted table structure when the quote goes through the editor", () => {
    const flattened = editorRoundTrip(quoteBlock(INVOICE_TABLE));
    expect(flattened).not.toContain("<table");
    expect(flattened).not.toContain("<td");
    // The text survives — which is exactly why the loss went unnoticed.
    expect(flattened).toContain("Consulting");
  });

  it("keeps the quote intact when it is split out instead", () => {
    const body = `<p>Approved.</p>${quoteBlock(INVOICE_TABLE)}`;
    const { editable, quoted } = splitQuotedTail(body);
    const sent = joinQuotedTail(editorRoundTrip(editable), quoted);
    expect(sent).toContain("<table");
    expect(sent).toContain("<td>Consulting</td>");
    expect(sent).toContain("Approved.");
  });
});

describe("splitQuotedTail", () => {
  it("returns the body unchanged as editable when there is no quote", () => {
    expect(splitQuotedTail("<p>New mail</p>")).toEqual({ editable: "<p>New mail</p>", quoted: "" });
  });

  it("handles an empty body", () => {
    expect(splitQuotedTail("")).toEqual({ editable: "", quoted: "" });
  });

  it("cuts at the quote wrapper, keeping everything before it editable", () => {
    const { editable, quoted } = splitQuotedTail(`<p>Hello</p>${quoteBlock("<p>Original</p>")}`);
    expect(editable).toBe("<p>Hello</p>");
    expect(quoted).toContain(QUOTE_MARKER_ATTR);
    expect(quoted).toContain("Original");
  });

  it("keeps the signature editable — it sits above the quote and the user owns it", () => {
    const body = `<p>Thanks</p><div ${SIGNATURE_MARKER_ATTR}="true"><p>-- Alice</p></div>${quoteBlock("<p>Original</p>")}`;
    const { editable, quoted } = splitQuotedTail(body);
    expect(editable).toContain(SIGNATURE_MARKER_ATTR);
    expect(quoted).not.toContain(SIGNATURE_MARKER_ATTR);
  });

  it("takes trailing siblings into the tail so re-joining preserves document order", () => {
    const body = `<p>Head</p>${quoteBlock("<p>Original</p>")}<p>After</p>`;
    const { editable, quoted } = splitQuotedTail(body);
    expect(editable).toBe("<p>Head</p>");
    expect(quoted.indexOf("Original")).toBeLessThan(quoted.indexOf("After"));
    expect(joinQuotedTail(editable, quoted)).toContain("Head");
  });

  // A marker nested inside the original (a quote of a quote) does not describe
  // where THIS composer's editable region ends; cutting there would freeze the
  // user's own text into the tail.
  it("ignores a marker nested inside the quoted original", () => {
    const nested = `<p>Mine</p><div ${QUOTE_MARKER_ATTR}="true"><blockquote><div ${QUOTE_MARKER_ATTR}="true"><p>Older</p></div></blockquote></div>`;
    const { editable, quoted } = splitQuotedTail(nested);
    expect(editable).toBe("<p>Mine</p>");
    expect(quoted).toContain("Older");
  });

  it("round-trips losslessly through split then join", () => {
    const body = `<p>Hello</p>${quoteBlock(INVOICE_TABLE)}`;
    const { editable, quoted } = splitQuotedTail(body);
    expect(joinQuotedTail(editable, quoted)).toBe(body);
  });
});

describe("joinQuotedTail", () => {
  it("returns the editable half untouched when there is no tail", () => {
    expect(joinQuotedTail("<p>a</p>", "")).toBe("<p>a</p>");
  });

  it("appends the tail after the editable half", () => {
    expect(joinQuotedTail("<p>a</p>", "<div>q</div>")).toBe("<p>a</p><div>q</div>");
  });
});
