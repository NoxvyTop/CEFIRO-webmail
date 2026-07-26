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
 * True for a `<p>` with no meaningful content — nothing, whitespace, or a
 * lone `<br>` — the exact shape of the filler paragraph
 * `ensureWritableRegionBefore` inserts below. Used on removal to tell a
 * genuinely-empty helper paragraph apart from real user content (which must
 * never be deleted, even if it happens to sit directly above the wrapper).
 */
function isEmptyParagraph(element: Element): boolean {
  if (element.tagName !== "P") return false;
  if ((element.textContent ?? "").trim().length > 0) return false;
  return Array.from(element.children).every((child) => child.tagName === "BR");
}

/**
 * Guarantees a writable region exists immediately before `wrapper` (the
 * signature marker div). An empty new-mail body, or a quote-only
 * reply/forward body with nothing typed above the quote yet, would
 * otherwise leave the signature as the very first (or only) node — the
 * user has nowhere to click/type (#128), and the signature reads as if it
 * were pinned to the top of the message (#121). A no-op whenever *anything*
 * already precedes the wrapper — real content or a filler paragraph left
 * by an earlier apply — so repeated applies/switches never stack up blank
 * paragraphs.
 */
function ensureWritableRegionBefore(doc: Document, wrapper: Element): void {
  if (wrapper.previousElementSibling) return;
  wrapper.before(doc.createElement("p"));
}

/**
 * Pure body-manipulation helper for the composer's signature block.
 *
 * - `signature` is `null`: removes the existing marked wrapper, if any (a
 *   no-op when no wrapper is present) — along with the filler paragraph
 *   `ensureWritableRegionBefore` may have inserted above it, but only if
 *   that paragraph is still empty (real content is never deleted, even if
 *   it happens to sit directly above the wrapper).
 * - `signature` is provided and a wrapper already exists: replaces its
 *   content in place — this is what keeps re-selecting a signature (or
 *   auto-applying the same default on repeated opens) from stacking a
 *   second copy.
 * - `signature` is provided and no wrapper exists yet: inserts a new
 *   wrapper, placed immediately before the quoted-original block (marked
 *   with `QUOTE_MARKER_ATTR`) when one is present, otherwise appended at
 *   the end of the body (new mail has no quote to place it above).
 *
 * Either way, once the wrapper is in place, `ensureWritableRegionBefore`
 * guarantees a writable region precedes it (see its own doc comment).
 *
 * The visual line separating the body from the signature (also #121) is
 * drawn purely in CSS (see index.css, keyed off `SIGNATURE_MARKER_ATTR`) —
 * editor chrome, not body HTML, so it never reaches a sent email.
 */
export function applySignature(bodyHtml: string, signature: SignatureContent | null): string {
  const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
  const existing = doc.body.querySelector(`[${SIGNATURE_MARKER_ATTR}]`);

  if (!signature) {
    if (existing) {
      const filler = existing.previousElementSibling;
      if (filler && isEmptyParagraph(filler)) filler.remove();
      existing.remove();
    }
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

  ensureWritableRegionBefore(doc, wrapper);

  return doc.body.innerHTML;
}

/**
 * Strips the internal `SIGNATURE_MARKER_ATTR` / `QUOTE_MARKER_ATTR` wrapper
 * divs from a composer body, unwrapping them in place (children are kept,
 * only the marker element itself is removed). These markers are an
 * implementation detail of applySignature's find/replace/remove logic — they
 * must never leak into a sent email's HTML, so this MUST run on `bodyHtml`
 * right before it's used to build the outgoing `htmlBody` (see useComposer's
 * send()). A no-op when no markers are present.
 */
export function stripSignatureMarkers(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const markers = doc.body.querySelectorAll(`[${SIGNATURE_MARKER_ATTR}], [${QUOTE_MARKER_ATTR}]`);

  for (const marker of Array.from(markers)) {
    while (marker.firstChild) {
      marker.parentNode?.insertBefore(marker.firstChild, marker);
    }
    marker.remove();
  }

  return doc.body.innerHTML;
}
