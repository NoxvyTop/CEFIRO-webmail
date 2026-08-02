import { QUOTE_MARKER_ATTR } from "./signature";

export type SplitBody = {
  /** The part the user actually authors — fed to the rich text editor. */
  editable: string;
  /**
   * The quoted original, verbatim, byte for byte as reply.ts's quotedBody
   * produced it. Empty for a new mail, which has nothing quoted.
   */
  quoted: string;
};

/**
 * GH #142: splits a composer body into the part the editor may own and the
 * quoted original it must not touch.
 *
 * The editor's schema is TipTap StarterKit plus a handful of local nodes. A
 * ProseMirror schema does not "mostly keep" markup it has no node for — it
 * discards the element and lifts the children into the nearest legal parent.
 * So a quoted invoice table, a schedule, a side-by-side comparison, anything
 * built out of <table>/<div>/<span> or inline styles, survives as text but
 * loses its structure the moment the document is parsed. The recipient gets
 * their own content back, flattened.
 *
 * Two fixes were possible. Extending the schema to cover what quotes contain
 * is unbounded: reader/sanitize.ts hands the quote DOMPurify's whole HTML
 * profile, so "what can appear in a quote" is essentially all of HTML plus
 * arbitrary inline CSS, and every tag still missing a node keeps flattening
 * silently. Keeping the quote out of the editable document is bounded and
 * total — markup that is never parsed cannot be lossy — and the marker
 * delimiting it already exists.
 *
 * The tail is the marked quote element AND everything after it, not the
 * element alone, so re-joining restores the original document order rather
 * than hoisting trailing content above the quote.
 */
export function splitQuotedTail(html: string): SplitBody {
  if (!html) return { editable: "", quoted: "" };

  const doc = new DOMParser().parseFromString(html, "text/html");
  // Only a top-level quote wrapper delimits the tail. A marker nested deeper
  // (a quote inside a quote inside the original) does not describe where THIS
  // composer's editable region ends, and cutting there would move the user's
  // own text into the frozen tail.
  const quote = Array.from(doc.body.children).find((child) =>
    child.hasAttribute(QUOTE_MARKER_ATTR),
  );
  if (!quote) return { editable: html, quoted: "" };

  const tail: string[] = [];
  let node: Element | null = quote;
  while (node) {
    const next: Element | null = node.nextElementSibling;
    tail.push(node.outerHTML);
    node.remove();
    node = next;
  }

  return { editable: doc.body.innerHTML, quoted: tail.join("") };
}

/**
 * Re-attaches a tail taken by splitQuotedTail. Plain concatenation is the
 * whole operation: the tail was cut at a top-level element boundary and is put
 * back at the end, which is where it was.
 */
export function joinQuotedTail(editable: string, quoted: string): string {
  return quoted ? `${editable}${quoted}` : editable;
}
