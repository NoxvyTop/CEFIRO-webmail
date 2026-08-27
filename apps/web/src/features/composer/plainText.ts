import { QUOTE_MARKER_ATTR } from "./signature";

// Elements whose text content is machinery rather than message text — CSS
// rules, script source, an unrendered <template>'s markup. textContent would
// otherwise splice them into the visible text verbatim.
const NON_RENDERED_TEXT_SELECTOR = "script, style, noscript, template, title";

// Elements that end a visual line when rendered, so their boundary becomes a
// newline rather than silently concatenating two paragraphs into one run-on.
const LINE_BREAKING_TAGS = new Set([
  "address", "article", "blockquote", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "li", "p", "pre", "section", "table", "tr", "ul", "ol",
]);

// RFC 5322 / long-standing Usenet-and-mail convention: a quoted line is marked
// with ">". The trailing space is the readable form every mainstream client
// emits; a line that would otherwise be empty gets the bare marker instead, so
// blank lines inside a quote stay visibly part of the quote rather than looking
// like the quote ended.
const QUOTE_PREFIX = "> ";
const EMPTY_QUOTE_PREFIX = ">";

/**
 * Parses `html` in a detached DOMParser document — the same pattern
 * reader/sanitize.ts and reader/EmailBody.tsx rely on: nodes are read into a
 * document that is never attached to this page, so nothing in the untrusted
 * markup executes, loads a resource, or applies a style.
 */
function parseDetachedBody(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const element of Array.from(doc.querySelectorAll(NON_RENDERED_TEXT_SELECTOR))) {
    element.remove();
  }
  return doc.body;
}

// Raw flatten with no tidying, so callers that need to flatten several pieces
// separately (see composeTextBody) can tidy each piece once, at the end.
function flattenToText(root: ParentNode): string {
  const parts: string[] = [];

  function walk(node: ChildNode) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === "br") {
      parts.push("\n");
      return;
    }
    for (const child of Array.from(element.childNodes)) walk(child);
    if (LINE_BREAKING_TAGS.has(tag)) parts.push("\n");
  }

  for (const child of Array.from(root.childNodes)) walk(child);
  return parts.join("");
}

// Collapses the runs of blank lines that nested block wrappers produce (a
// <div><p>…</p></div> contributes two newlines for one visual break).
function tidy(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Renders `html` as the plain text a reader would see, dropping every element
 * and attribute. Only text nodes survive, so the returned string carries no
 * markup at all — which is the point: see RichTextEditor's
 * ContentEditableFallback for why that path cannot render live HTML.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  return tidy(flattenToText(parseDetachedBody(html)));
}

function prefixQuotedLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${QUOTE_PREFIX}${line}` : EMPTY_QUOTE_PREFIX))
    .join("\n");
}

/**
 * GH #141: builds the `text/plain` alternative of an outgoing message.
 *
 * htmlToPlainText alone drops every tag, which flattens the quoted original
 * into the same undifferentiated run of text as what the user just wrote. In a
 * plain-text client the reply and the entire conversation it quotes then arrive
 * as one continuous block with nothing marking where the new message ends —
 * breaking the oldest convention in email.
 *
 * The quoted block is located by QUOTE_MARKER_ATTR, the marker
 * composer/signature.ts already writes around it. That marker is an internal
 * bookkeeping attribute stripped from the outgoing *HTML* alternative, so this
 * MUST be called on the composer body BEFORE stripSignatureMarkers runs (see
 * useComposer's buildComposePayload) — afterwards there is nothing left to key
 * on and the quote becomes unfindable.
 *
 * Inside that block the attribution line ("<date> — <sender>:") is left
 * unprefixed and the <blockquote> body is prefixed, which is the shape every
 * mainstream client produces:
 *
 *     what the user wrote
 *
 *     2026-07-01T10:00:00.000Z — Alice:
 *     > the original message
 *     > second line
 *
 * Quoting is one level deep regardless of how deeply the original nested its
 * own blockquotes. Per-level depth is a refinement; the bug is the total
 * absence of a marker, and one unambiguous level fixes that without inventing
 * an ancestry the HTML may not reliably describe.
 */
export function composeTextBody(html: string): string {
  if (!html) return "";
  const body = parseDetachedBody(html);

  const quote = body.querySelector(`[${QUOTE_MARKER_ATTR}]`);
  if (!quote) return tidy(flattenToText(body));

  // Detach so the remainder flattens without the quote's text; `quote` itself
  // keeps its children and stays usable.
  quote.remove();
  const head = tidy(flattenToText(body));

  const blockquote = quote.querySelector("blockquote");
  let attribution = "";
  let quoted: string;
  if (blockquote) {
    blockquote.remove();
    attribution = tidy(flattenToText(quote));
    quoted = tidy(flattenToText(blockquote));
  } else {
    // No blockquote to separate: the whole marked block is quoted material.
    quoted = tidy(flattenToText(quote));
  }

  const quoteBlock = [attribution, quoted && prefixQuotedLines(quoted)]
    .filter((part) => part.length > 0)
    .join("\n");

  return [head, quoteBlock].filter((part) => part.length > 0).join("\n\n");
}
