export type SignatureContent = { contentHtml: string };

// Marks the single signature block in a composer body so it can be found,
// replaced, or removed deterministically instead of being appended to on
// every switch (the previous behavior stacked signatures — see the fix this
// module addresses).
export const SIGNATURE_MARKER_ATTR = "data-cefiro-signature";

// Marks the quoted-original block produced by reply.ts's quotedBody, so the
// signature can be placed above it (Gmail places the default signature above
// the quote, not inside or below it).
export const QUOTE_MARKER_ATTR = "data-cefiro-quote";

/**
 * Pure body-manipulation helper for the composer's signature block.
 *
 * - `signature` is `null`: removes the existing marked wrapper, if any (a
 *   no-op when no wrapper is present).
 * - `signature` is provided and a wrapper already exists: replaces its
 *   content in place — this is what keeps re-selecting a signature (or
 *   auto-applying the same default on repeated opens) from stacking a
 *   second copy.
 * - `signature` is provided and no wrapper exists yet: inserts a new
 *   wrapper, placed immediately before the quoted-original block (marked
 *   with `QUOTE_MARKER_ATTR`) when one is present, otherwise appended at
 *   the end of the body (new mail has no quote to place it above).
 */
export function applySignature(bodyHtml: string, signature: SignatureContent | null): string {
  const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
  const existing = doc.body.querySelector(`[${SIGNATURE_MARKER_ATTR}]`);

  if (!signature) {
    existing?.remove();
    return doc.body.innerHTML;
  }

  const wrapper = existing ?? doc.createElement("div");
  wrapper.setAttribute(SIGNATURE_MARKER_ATTR, "true");
  wrapper.innerHTML = signature.contentHtml;

  if (!existing) {
    const quote = doc.body.querySelector(`[${QUOTE_MARKER_ATTR}]`);
    if (quote) {
      quote.before(wrapper);
    } else {
      doc.body.appendChild(wrapper);
    }
  }

  return doc.body.innerHTML;
}
