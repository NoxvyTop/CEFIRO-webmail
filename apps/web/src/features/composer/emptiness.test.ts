import { describe, expect, it } from "vitest";
import { isComposerBodyEmpty, isComposerDraftEmpty } from "./emptiness";
import type { ComposerDraft } from "./reply";
import { QUOTE_MARKER_ATTR, SIGNATURE_MARKER_ATTR } from "./signature";

const SIGNATURE = `<div ${SIGNATURE_MARKER_ATTR}="1"><p>Ana Pérez</p><p>Céfiro</p></div>`;
const QUOTE = `<div ${QUOTE_MARKER_ATTR}="1"><blockquote><p>Original message text</p></blockquote></div>`;

function draft(overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    identityId: "identity-1",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    bodyHtml: "",
    ...overrides,
  };
}

const address = (email: string) => ({ name: "", email });

// This rule decides whether closing the composer discards silently or asks for
// confirmation, so its failure mode is silent data loss. A false "empty"
// throws away a message the user wrote. That is why it is tested directly
// rather than through the component: an indirect test can pass for reasons
// that have nothing to do with this function being right.
describe("isComposerBodyEmpty", () => {
  it("treats an untouched body as empty", () => {
    expect(isComposerBodyEmpty("")).toBe(true);
    expect(isComposerBodyEmpty("<p><br></p>")).toBe(true);
    expect(isComposerBodyEmpty("<p>   </p>")).toBe(true);
  });

  it("treats an auto-applied signature as empty", () => {
    // Machine-inserted on open, not something the user typed.
    expect(isComposerBodyEmpty(`<p><br></p>${SIGNATURE}`)).toBe(true);
  });

  it("treats a reply that was opened but not typed into as empty", () => {
    expect(isComposerBodyEmpty(`<p><br></p>${QUOTE}${SIGNATURE}`)).toBe(true);
  });

  it("counts text the user typed above the quote", () => {
    expect(isComposerBodyEmpty(`<p>Conforme</p>${QUOTE}${SIGNATURE}`)).toBe(false);
  });

  it("counts an image as content even though it carries no text", () => {
    expect(isComposerBodyEmpty(`<p><img src="cid:photo"></p>${SIGNATURE}`)).toBe(false);
  });

  it("does not count text that lives inside the signature or the quote", () => {
    // Everything nested inside a marker wrapper goes with it. Otherwise the
    // signature's own words would make every draft look non-empty.
    expect(isComposerBodyEmpty(SIGNATURE)).toBe(true);
    expect(isComposerBodyEmpty(QUOTE)).toBe(true);
  });

  it("does not count an image that belongs to the signature", () => {
    const logo = `<div ${SIGNATURE_MARKER_ATTR}="1"><img src="cid:logo"></div>`;
    expect(isComposerBodyEmpty(logo)).toBe(true);
  });
});

describe("isComposerDraftEmpty", () => {
  it("is empty only when every field is", () => {
    expect(isComposerDraftEmpty(draft(), 0, 0)).toBe(true);
  });

  it.each([
    ["to", { to: [address("ana@cefiro.test")] }],
    ["cc", { cc: [address("ana@cefiro.test")] }],
    ["bcc", { bcc: [address("ana@cefiro.test")] }],
  ])("counts a recipient in %s", (_field, overrides) => {
    expect(isComposerDraftEmpty(draft(overrides), 0, 0)).toBe(false);
  });

  it("counts a subject", () => {
    expect(isComposerDraftEmpty(draft({ subject: "Presupuesto" }), 0, 0)).toBe(false);
  });

  it("ignores a subject that is only whitespace", () => {
    expect(isComposerDraftEmpty(draft({ subject: "   " }), 0, 0)).toBe(true);
  });

  it("counts an uploaded attachment", () => {
    expect(isComposerDraftEmpty(draft(), 1, 0)).toBe(false);
  });

  it("counts an upload that is still in flight", () => {
    // It has no blobId yet, but the user already picked the file and started
    // the upload, and there is no way to recreate that by retyping.
    expect(isComposerDraftEmpty(draft(), 0, 1)).toBe(false);
  });

  it("counts a typed body", () => {
    expect(isComposerDraftEmpty(draft({ bodyHtml: "<p>Hola</p>" }), 0, 0)).toBe(false);
  });

  it("stays empty for a reply carrying only its quote and signature", () => {
    const bodyHtml = `<p><br></p>${QUOTE}${SIGNATURE}`;
    expect(isComposerDraftEmpty(draft({ bodyHtml }), 0, 0)).toBe(true);
  });
});
