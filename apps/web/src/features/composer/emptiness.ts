import type { ComposerDraft } from "./reply";
import { QUOTE_MARKER_ATTR, SIGNATURE_MARKER_ATTR } from "./signature";

/**
 * True when `bodyHtml` carries no content the user actually typed.
 *
 * The composer's signature and quote wrapper divs (see composer/signature.ts's
 * SIGNATURE_MARKER_ATTR and composer/reply.ts's QUOTE_MARKER_ATTR) are both
 * machine-inserted: a default signature is auto-applied on open
 * (Composer.tsx's appliedDefaultRef effect) and a reply/forward's quoted
 * original is inserted by replyDraft/forwardDraft. Neither is something the
 * user typed, so neither may count as body content on its own — a reply
 * opened but not typed into must read as empty despite carrying both a quote
 * and a signature (GH #125).
 *
 * Both wrapper elements (and everything inside them) are removed before
 * checking what remains. What's left over — whitespace-only text, and the
 * empty filler paragraph applySignature's ensureWritableRegionBefore may have
 * inserted directly above the signature wrapper — is not user content
 * either, so an empty-after-stripping result means the body is empty.
 */
export function isComposerBodyEmpty(bodyHtml: string): boolean {
  const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
  doc.body
    .querySelectorAll(`[${SIGNATURE_MARKER_ATTR}], [${QUOTE_MARKER_ATTR}]`)
    .forEach((marker) => marker.remove());

  if ((doc.body.textContent ?? "").trim().length > 0) return false;
  // A user-inserted image carries no text but is still real content.
  if (doc.body.querySelector("img")) return false;

  return true;
}

/**
 * True when the composer draft as a whole has nothing the user would lose by
 * closing without confirmation: no recipient in any field, no subject, an
 * effectively empty body per isComposerBodyEmpty, and no attachment — either
 * already uploaded or still uploading. Drives the Escape-to-close decision
 * (GH #125): empty closes immediately, anything else shows the discard
 * confirmation.
 *
 * attachmentCount/uploadCount are passed in as plain counts rather than the
 * full Attachment[]/PendingUpload[] arrays (see useComposer.ts) so this
 * module — which only needs "how many," not their shape — doesn't have to
 * import composer state types. Attachment state lives on useComposer's
 * ComposerState, a sibling of ComposerDraft, not on the draft itself; this
 * is the one place that combines both so the emptiness rule stays whole
 * instead of being split between this file and its caller.
 *
 * An in-flight upload counts exactly like a finished one: it has no blobId
 * yet, but the user already did real work outside the app (picked the file,
 * started the upload) to produce it, and closing without confirmation would
 * lose that — the same failure this whole rule exists to prevent, only
 * worse, since there is no way to recreate an in-flight upload by retyping.
 */
export function isComposerDraftEmpty(
  draft: ComposerDraft,
  attachmentCount: number,
  uploadCount: number,
): boolean {
  if (draft.to.length + draft.cc.length + draft.bcc.length > 0) return false;
  if (draft.subject.trim().length > 0) return false;
  if (attachmentCount > 0 || uploadCount > 0) return false;
  return isComposerBodyEmpty(draft.bodyHtml);
}
