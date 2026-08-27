import { describe, expect, it } from "vitest";
import {
  applySignature,
  QUOTE_MARKER_ATTR,
  SIGNATURE_MARKER_ATTR,
  stripSignatureMarkers,
} from "./signature";

function sig(contentHtml: string) {
  return { contentHtml };
}

describe("applySignature", () => {
  it("inserts a marked wrapper into an empty body, preceded by a filler paragraph so there is somewhere to type (#128)", () => {
    const result = applySignature("", sig("<p>Thanks, Alice</p>"));
    expect(result).toBe(`<p></p><div ${SIGNATURE_MARKER_ATTR}="true"><p>Thanks, Alice</p></div>`);
  });

  it("appends the wrapper at the end of a non-empty body with no quote", () => {
    const result = applySignature("<p>Hello there</p>", sig("<p>Thanks, Alice</p>"));
    expect(result).toBe(
      `<p>Hello there</p><div ${SIGNATURE_MARKER_ATTR}="true"><p>Thanks, Alice</p></div>`,
    );
  });

  it("inserts the wrapper before the quoted block when one is present (reply/forward placement), with a filler paragraph above it since nothing else precedes it", () => {
    const body = `<div ${QUOTE_MARKER_ATTR}="true"><blockquote><p>Original</p></blockquote></div>`;
    const result = applySignature(body, sig("<p>Thanks, Alice</p>"));
    expect(result).toBe(
      `<p></p>` +
        `<div ${SIGNATURE_MARKER_ATTR}="true"><p>Thanks, Alice</p></div>` +
        `<div ${QUOTE_MARKER_ATTR}="true"><blockquote><p>Original</p></blockquote></div>`,
    );
  });

  it("replaces an existing wrapper's content instead of stacking a second one", () => {
    const withFirst = applySignature("<p>Hello</p>", sig("<p>Signature A</p>"));
    const result = applySignature(withFirst, sig("<p>Signature B</p>"));

    expect(result).toBe(`<p>Hello</p><div ${SIGNATURE_MARKER_ATTR}="true"><p>Signature B</p></div>`);
    // never two wrapper elements
    const matches = result.match(new RegExp(SIGNATURE_MARKER_ATTR, "g")) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("removes the wrapper entirely when signature is null", () => {
    const withSignature = applySignature("<p>Hello</p>", sig("<p>Signature A</p>"));
    const result = applySignature(withSignature, null);
    expect(result).toBe("<p>Hello</p>");
  });

  it("is a no-op when removing a signature that was never applied", () => {
    const result = applySignature("<p>Hello</p>", null);
    expect(result).toBe("<p>Hello</p>");
  });

  it("preserves the rest of the body, including the quoted block, when replacing", () => {
    const body =
      `<p>My reply text</p>` +
      `<div ${SIGNATURE_MARKER_ATTR}="true"><p>Old sig</p></div>` +
      `<div ${QUOTE_MARKER_ATTR}="true"><blockquote><p>Original message</p></blockquote></div>`;
    const result = applySignature(body, sig("<p>New sig</p>"));

    expect(result).toBe(
      `<p>My reply text</p>` +
        `<div ${SIGNATURE_MARKER_ATTR}="true"><p>New sig</p></div>` +
        `<div ${QUOTE_MARKER_ATTR}="true"><blockquote><p>Original message</p></blockquote></div>`,
    );
  });

  it("is idempotent when applying the same signature repeatedly", () => {
    const once = applySignature("<p>Hello</p>", sig("<p>Signature A</p>"));
    const twice = applySignature(once, sig("<p>Signature A</p>"));
    const thrice = applySignature(twice, sig("<p>Signature A</p>"));

    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  // #128: guaranteeing a writable region above the signature.
  describe("writable-region invariant (#128)", () => {
    it("does not insert a filler paragraph when the body already has content above the insertion point", () => {
      const result = applySignature("<p>Hello there</p>", sig("<p>Thanks, Alice</p>"));
      // No leading empty <p> — "Hello there" already provides a writable region.
      expect(result).toBe(
        `<p>Hello there</p><div ${SIGNATURE_MARKER_ATTR}="true"><p>Thanks, Alice</p></div>`,
      );
    });

    it("does not accumulate filler paragraphs when switching signatures repeatedly on an initially empty body", () => {
      const first = applySignature("", sig("<p>Signature A</p>"));
      const second = applySignature(first, sig("<p>Signature B</p>"));
      const third = applySignature(second, sig("<p>Signature A</p>"));

      expect(second).toBe(`<p></p><div ${SIGNATURE_MARKER_ATTR}="true"><p>Signature B</p></div>`);
      // Switching back reproduces the exact same string as the first apply —
      // no extra/duplicated filler paragraphs picked up along the way.
      expect(third).toBe(first);
      expect(third.match(/<p><\/p>/g) ?? []).toHaveLength(1);
    });

    it("keeps the signature positioned before the quote block after the writable-region fix (position invariant)", () => {
      const body = `<div ${QUOTE_MARKER_ATTR}="true"><blockquote><p>Original</p></blockquote></div>`;
      const result = applySignature(body, sig("<p>Thanks, Alice</p>"));

      const signatureIndex = result.indexOf(SIGNATURE_MARKER_ATTR);
      const quoteIndex = result.indexOf(QUOTE_MARKER_ATTR);
      expect(signatureIndex).toBeGreaterThan(-1);
      expect(quoteIndex).toBeGreaterThan(signatureIndex);
    });

    it("removes the filler paragraph it inserted when the signature is later removed (cleanup)", () => {
      const applied = applySignature("", sig("<p>Thanks, Alice</p>"));
      const result = applySignature(applied, null);
      expect(result).toBe("");
    });

    it("does not remove real content when the signature is removed, even if it sits directly above the wrapper", () => {
      const applied = applySignature("<p>Hello</p>", sig("<p>Thanks, Alice</p>"));
      const result = applySignature(applied, null);
      expect(result).toBe("<p>Hello</p>");
    });
  });

  // #121: the boundary between body and signature.
  describe("body/signature separator (#121)", () => {
    it("never adds separator markup to the body HTML — the boundary is drawn in CSS only, keyed off the existing marker attribute", () => {
      const applied = applySignature("<p>Hello</p>", sig("<p>Thanks, Alice</p>"));
      expect(applied).not.toMatch(/<hr/i);

      const sent = stripSignatureMarkers(applied);
      expect(sent).not.toMatch(/<hr/i);
      expect(sent).not.toContain(SIGNATURE_MARKER_ATTR);
    });
  });
});

describe("stripSignatureMarkers", () => {
  it("unwraps the signature marker, keeping its content", () => {
    const body = `<p>Hi</p><div ${SIGNATURE_MARKER_ATTR}="true"><p>Thanks, Alice</p></div>`;
    expect(stripSignatureMarkers(body)).toBe("<p>Hi</p><p>Thanks, Alice</p>");
  });

  it("unwraps the quote marker, keeping its content", () => {
    const body = `<div ${QUOTE_MARKER_ATTR}="true"><br><blockquote><p>Original</p></blockquote></div>`;
    expect(stripSignatureMarkers(body)).toBe("<br><blockquote><p>Original</p></blockquote>");
  });

  it("unwraps both markers in one pass, preserving document order", () => {
    const body =
      `<p>My reply</p>` +
      `<div ${SIGNATURE_MARKER_ATTR}="true"><p>Thanks, Alice</p></div>` +
      `<div ${QUOTE_MARKER_ATTR}="true"><blockquote><p>Original</p></blockquote></div>`;
    expect(stripSignatureMarkers(body)).toBe(
      "<p>My reply</p><p>Thanks, Alice</p><blockquote><p>Original</p></blockquote>",
    );
  });

  it("is a no-op when no markers are present", () => {
    const body = "<p>Just a plain body</p>";
    expect(stripSignatureMarkers(body)).toBe(body);
  });

  it("is a no-op on an empty body", () => {
    expect(stripSignatureMarkers("")).toBe("");
  });

  it("leaves the #128 filler paragraph as plain, unmarked markup after unwrapping the signature", () => {
    const applied = applySignature("", sig("<p>Thanks, Alice</p>"));
    expect(stripSignatureMarkers(applied)).toBe("<p></p><p>Thanks, Alice</p>");
  });
});
