import { describe, expect, it } from "vitest";
import { applySignature, QUOTE_MARKER_ATTR, SIGNATURE_MARKER_ATTR } from "./signature";

function sig(contentHtml: string) {
  return { contentHtml };
}

describe("applySignature", () => {
  it("inserts a marked wrapper into an empty body", () => {
    const result = applySignature("", sig("<p>Thanks, Alice</p>"));
    expect(result).toBe(`<div ${SIGNATURE_MARKER_ATTR}="true"><p>Thanks, Alice</p></div>`);
  });

  it("appends the wrapper at the end of a non-empty body with no quote", () => {
    const result = applySignature("<p>Hello there</p>", sig("<p>Thanks, Alice</p>"));
    expect(result).toBe(
      `<p>Hello there</p><div ${SIGNATURE_MARKER_ATTR}="true"><p>Thanks, Alice</p></div>`,
    );
  });

  it("inserts the wrapper before the quoted block when one is present (reply/forward placement)", () => {
    const body = `<div ${QUOTE_MARKER_ATTR}="true"><blockquote><p>Original</p></blockquote></div>`;
    const result = applySignature(body, sig("<p>Thanks, Alice</p>"));
    expect(result).toBe(
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
});
