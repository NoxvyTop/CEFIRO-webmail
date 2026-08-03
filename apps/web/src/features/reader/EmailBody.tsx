import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { isQuoteSeparatorLine, type AttachmentMeta } from "@webmail/shared";
import { extractReferencedCids, sanitizeEmailHtml } from "./sanitize";

interface EmailBodyProps {
  bodyHtml: string | null;
  bodyText: string | null;
  attachments?: AttachmentMeta[];
  // GH #140: JMAP reported the fetched body as truncated, so bodyHtml/bodyText
  // below are only the beginning of the real message. Optional (defaulting to
  // "not truncated") so the many existing call sites and fixtures that predate
  // the flag keep their meaning.
  bodyTruncated?: boolean;
  // GH #275: reports the cids of referenced, safe-inline-image attachments
  // whose blob fetch failed, so they never rendered inline. ThreadView uses
  // this to keep such an attachment reachable as a downloadable chip instead
  // of leaving it as a broken inline icon with no download path. Optional so
  // existing callers/fixtures are unaffected.
  onInlineImageError?: (failedCids: string[]) => void;
}

// Mirrors the server's SAFE_INLINE_CONTENT_TYPES image subset (see also
// ThreadView's PREVIEWABLE_CONTENT_TYPES). Only these get fetched and
// inlined as data: URLs — a cid: pointing at any other content-type is left
// verbatim (broken image icon), so nothing but a genuine image is ever
// turned into a data: URL.
const SAFE_INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Exported so ThreadView can decide, up front and synchronously, whether a
// cid:-referenced attachment will ever actually render inline (see GH #134)
// — an attachment referenced by an unresolvable cid: must still surface as a
// downloadable attachment below the body, or the file becomes unreachable
// entirely (no inline render, no download link).
export function isSafeInlineImage(type: string): boolean {
  return SAFE_INLINE_IMAGE_TYPES.has(type.split(";")[0]?.trim().toLowerCase() ?? "");
}

function blobFetchUrl(blobId: string, name: string | null, type: string): string {
  const query = `name=${encodeURIComponent(name ?? "")}&type=${encodeURIComponent(type)}`;
  // No dl=1 — this must resolve inline (it's an embedded image, not a download).
  return `/api/mail/blobs/${encodeURIComponent(blobId)}?${query}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// The email body renders inside an `sandbox=""` iframe, which gives its
// srcdoc document an opaque origin — the browser will never attach the
// app's SameSite session cookie to a request that iframe makes on its own,
// so a plain same-origin `/api/mail/blobs/...` <img src> 401s from inside
// it. This runs in the PARENT document instead (which is authenticated),
// fetches the referenced attachment's bytes with the session cookie, and
// base64-encodes them into a data: URL — data: URLs need no network
// request and have no origin at all, so they render fine inside the
// sandboxed iframe without loosening the sandbox.
async function fetchAsDataUrl(blobId: string, name: string | null, type: string): Promise<string> {
  const response = await fetch(blobFetchUrl(blobId, name, type), { credentials: "include" });
  if (!response.ok) throw new Error(`blob fetch failed: ${response.status}`);
  const buffer = await response.arrayBuffer();
  // Anchor the data: prefix to the vetted base type (this is only reached for
  // allowlisted image types), never the raw sender-controlled type string.
  const baseType = type.split(";")[0]!.trim().toLowerCase();
  return `data:${baseType};base64,${arrayBufferToBase64(buffer)}`;
}

/**
 * Resolves cid: image references in bodyHtml to data: URLs. Only
 * attachments that (a) carry a cid, (b) are actually referenced by a cid:
 * image in the body, and (c) are a safe inline-image type are fetched — see
 * isSafeInlineImage. Non-image cids and cids with no matching attachment
 * are left unresolved (sanitize renders them verbatim — a transient/
 * permanent broken image icon, not a security fallback).
 *
 * Async and racy by nature (message navigation can happen mid-fetch): each
 * effect run captures its own `isCurrent` flag and only commits its
 * resolved map while still current, so a slow, now-stale fetch from a
 * previous message can never overwrite (or partially merge into) the
 * current message's state after the user has moved on.
 */
function useResolvedCidImageMap(
  bodyHtml: string | null,
  attachments: AttachmentMeta[] | undefined,
): { resolvedMap: Record<string, string>; failedCids: string[] } {
  const candidates = useMemo(() => {
    if (!bodyHtml) return [];
    const referencedCids = extractReferencedCids(bodyHtml);
    return (attachments ?? []).filter(
      (attachment): attachment is AttachmentMeta & { cid: string } =>
        Boolean(attachment.cid) &&
        referencedCids.has(attachment.cid as string) &&
        isSafeInlineImage(attachment.type),
    );
  }, [bodyHtml, attachments]);

  const [resolvedMap, setResolvedMap] = useState<Record<string, string>>({});
  // GH #275: cids among the candidates whose fetch rejected — a candidate is,
  // by construction, a referenced safe-image attachment that was SUPPOSED to
  // render inline, so a failure here means it renders as nothing (broken icon)
  // and must be surfaced as a downloadable chip instead of vanishing.
  const [failedCids, setFailedCids] = useState<string[]>([]);

  useEffect(() => {
    let isCurrent = true;

    if (candidates.length === 0) {
      setResolvedMap({});
      setFailedCids([]);
      return;
    }

    // Clear any previous message's resolved/failed entries immediately so a
    // stale map is never briefly attributed to the new message.
    setResolvedMap({});
    setFailedCids([]);

    Promise.all(
      candidates.map(async (attachment) => {
        try {
          const dataUrl = await fetchAsDataUrl(attachment.blobId, attachment.name, attachment.type);
          return { cid: attachment.cid, dataUrl } as const;
        } catch {
          // Fetch/network failure: leave this cid unresolved rather than
          // falling back to an unauthenticated (401-prone) blob URL, and
          // record it as failed so its attachment stays reachable (GH #275).
          return { cid: attachment.cid, dataUrl: null } as const;
        }
      }),
    ).then((results) => {
      if (!isCurrent) return;
      const resolved: Record<string, string> = {};
      const failed: string[] = [];
      for (const entry of results) {
        if (entry.dataUrl) resolved[entry.cid] = entry.dataUrl;
        else failed.push(entry.cid);
      }
      setResolvedMap(resolved);
      setFailedCids(failed);
    });

    return () => {
      isCurrent = false;
    };
  }, [candidates]);

  return { resolvedMap, failedCids };
}

// HTML emails are authored assuming a light background (the Gmail/Outlook
// "paper" convention), so the iframe canvas is always painted light —
// regardless of the app's active theme. Matching the app's dark theme here
// would turn styled marketing HTML with hardcoded dark text (e.g.
// color:#333 on an implicit white background) into unreadable dark-on-dark
// text; rendering it as a clean white card is the safe, standard webmail
// behavior for both simple and styled bodies. Fixed constants — never
// derived from email-controlled content or the app theme.
const EMAIL_PAPER_INK = "#101318";
const EMAIL_PAPER_PANEL = "#ffffff";
const EMAIL_PAPER_COLOR_SCHEME = "light";

// Used until (or unless) the content height can be measured — see
// useContentHeight below for why real sandboxed browsers usually can't (in
// practice this fallback is what most real users see). A generous,
// viewport-proportional value replaces the old fixed 200px box, which read
// as a squat frame floating in dead space (OSCURO-04). Genuine HTML emails
// that reach this fallback are now routed here for real formatted content
// only (see isEffectivelyPlainText below) — short plain-text messages take
// the auto-sizing <pre> path instead, so this constant no longer needs to
// cover the "short plain text" case; kept generous but a bit lower than
// before (was min(60vh, 640px)) since genuine short HTML is the only
// remaining case that still shows a void while the iframe is unmeasurable.
const FALLBACK_HEIGHT = "min(50vh, 520px)";

// GH #135/#276: very long/tall HTML messages (typically marketing/newsletter
// mail, or an image-heavy signature or receipt) render clipped, with a "View
// entire message" control that reveals the rest.
//
// GH #276: the decision is made on the message's RENDERED HEIGHT, not its text
// length. The real rendered height is used whenever it can be measured (see
// useContentHeight below). It usually can't: a sandbox iframe without
// allow-same-origin gives its srcdoc an opaque origin, so contentDocument —
// and therefore the real pixel height — is unreachable from here in real
// browsers by design (loosening that would weaken the isolation of untrusted
// email HTML, so it stays as-is). For that common case the height is ESTIMATED
// from the sanitized HTML string itself, before the iframe ever mounts — the
// same "decide from outside the sandbox, up front" constraint that
// detectAuthoredContentWidth works under. Crucially the estimate counts
// IMAGES, not just characters: a short-text-but-tall message (a signature or
// receipt built mostly from images) used to slip under the old text-only
// threshold, fall to FALLBACK_HEIGHT, and hide its lower half behind the
// invisible overlay scrollbar #160 documents — exactly the GH #276 bug.

// Real measured px above which the body is clipped. Sits well above an
// ordinary reply and the FALLBACK_HEIGHT box, so only a genuinely tall
// message is clipped once its true height is known.
const MEASURED_CLIP_HEIGHT_PX = 640;

// Estimate px above which the body is clipped when the real height can't be
// measured — same px unit as estimateRenderedHeightPx below. Calibrated to
// roughly the old ~1000-character trigger for text-only mail (this reader's
// ~14KB Solandra Outlet newsletter fixture in e2e/fixtures/mail.ts extracts
// to ~1,570 characters, comfortably over it) while now also catching
// image-heavy short-text bodies, and staying above an ordinary
// multi-paragraph human reply so everyday correspondence isn't clipped.
const ESTIMATED_CLIP_HEIGHT_PX = 280;

// Coarse per-node contributions for the pre-mount estimate — it only needs to
// tell "tall" from "short", never be pixel-accurate.
const ESTIMATE_LINE_PX = 22; // ~one wrapped line of 15px/1.65 body text
const ESTIMATE_CHARS_PER_LINE = 80; // rough wrap width in the reader column
const ESTIMATE_IMAGE_PX = 180; // a typical inline image / logo / banner row

// Clipped preview height — enough to establish context (subject/opening
// content) without showing a near-full screen of an unread message.
// Viewport-proportional, matching FALLBACK_HEIGHT's own pattern.
const CLIPPED_BODY_HEIGHT = "min(35vh, 260px)";

// Best-effort rendered-height estimate (px) from a sanitized HTML string,
// used only when the real height can't be measured — see the GH #276 note
// above for why that's the common case. Parsed via the same safe,
// detached-document DOMParser pattern used throughout this file
// (isEffectivelyPlainText, splitQuotedHtml, ...) — reads structure/text only,
// never executes anything in the (already-sanitized, here) markup. Counts
// visible text wrapped to lines PLUS a flat contribution per image, which is
// what makes an image-heavy signature/receipt tall despite little text.
function estimateRenderedHeightPx(html: string): number {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const textLength = (doc.body.textContent ?? "").trim().length;
  const textPx = Math.ceil(textLength / ESTIMATE_CHARS_PER_LINE) * ESTIMATE_LINE_PX;
  const imagePx = doc.body.querySelectorAll("img").length * ESTIMATE_IMAGE_PX;
  return textPx + imagePx;
}

// Tags that show up when plain text gets wrapped in trivial HTML (line/
// paragraph breaks) and carry no formatting of their own. This is an
// ALLOWLIST, not a blocklist: any tag outside this set — or any element in
// this set that carries an attribute (style, class, href, src, ...) — fails
// the "trivial" check. Allowlisting fails closed: an element type nobody
// thought to blocklist (a custom element, <marquee>, a future HTML tag) is
// treated as real markup by default, not silently let through as trivial.
const TRIVIAL_TAG_NAMES = new Set(["br", "p", "div", "span"]);

/**
 * Returns true when bodyHtml has NO meaningful HTML markup — i.e. it is
 * effectively the same plain-text content as bodyText, just wrapped in
 * inert tags (a common pattern: servers sometimes synthesize bodyHtml from
 * bodyText verbatim, or wrap it in a bare <p>/<br> structure with no real
 * formatting). When true, EmailBody renders the auto-sizing text path
 * instead of the sandboxed iframe, so a short plain-text message doesn't
 * sit inside a large empty box sized for HTML content that isn't there.
 *
 * The check is purely structural on bodyHtml (parsed the same
 * detached-document way as sanitize.ts's extractReferencedCids — DOMParser
 * only reads into a detached document, it never executes scripts or
 * attaches to the page, so this is safe to run on raw, unsanitized email
 * HTML): every element in the parsed tree must be one of TRIVIAL_TAG_NAMES
 * and carry no attributes. A single <img>, <a>, <table>, heading, list,
 * <blockquote>, <pre>, <hr>, or any element with a style/class/bgcolor/
 * background attribute means the body is genuinely formatted HTML, and
 * this returns false so it keeps rendering in the secure sandboxed iframe,
 * unchanged.
 *
 * Safety in both directions:
 *  - A genuine HTML email (the newsletter with tables/colors/images) always
 *    contains at least one non-trivial tag or attribute, so it can never be
 *    misclassified as plain text and lose its formatting.
 *  - A plain-text email that happens to contain a stray "<" (e.g. "5 < 10")
 *    either parses as inert text (most cases — HTML5 parsing requires a
 *    letter immediately after "<" to start a tag) or, in the rarer case
 *    where it accidentally looks like a real tag (e.g. "a<b then c>d"
 *    parses as a literal <b> element), it correctly falls to false — safe
 *    ambiguity is resolved by keeping the well-tested iframe path, not by
 *    guessing that it's plain text.
 *  - bodyText itself is never at risk of HTML injection here regardless of
 *    this function's verdict: the text path renders it as a React text
 *    child (`{bodyText}`), which always escapes markup — never via
 *    dangerouslySetInnerHTML — so a stray angle bracket in bodyText can
 *    never be interpreted as HTML.
 *
 * bodyText is accepted for API symmetry with the call site (and to leave
 * room for a future stricter check, e.g. comparing extracted text against
 * bodyText) but the current rule intentionally only inspects bodyHtml's
 * structure — see the "robust simple version" this implements.
 */
export function isEffectivelyPlainText(
  bodyHtml: string | null | undefined,
  _bodyText?: string | null,
): boolean {
  if (!bodyHtml || !bodyHtml.trim()) return true;

  const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    if (!TRIVIAL_TAG_NAMES.has(el.tagName.toLowerCase())) return false;
    if (el.attributes.length > 0) return false;
  }
  return true;
}

// Extracts a readable text rendering of a bodyHtml that isEffectivelyPlainText
// has already confirmed is trivial (only br/p/div/span, no attributes) —
// used as the last-resort source of display text when there's no bodyText
// prop at all, so a trivial-HTML-only email still shows its content instead
// of the empty-body message. <br> and block-level p/div boundaries become
// newlines so multi-line content doesn't get smashed into one line by
// textContent's default behavior.
function extractTextFromTrivialHtml(bodyHtml: string): string {
  const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
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
    if (tag === "p" || tag === "div") parts.push("\n");
  }

  for (const child of Array.from(doc.body.childNodes)) walk(child);
  return parts.join("").trim();
}

// --- Quoted-trail detection & split (GH #91) ---
//
// Each reply in a thread tends to repeat the entire previous message as a
// quoted trail beneath the new content (Gmail's `<blockquote
// class="gmail_quote">` / `<div class="gmail_quote">` wrapper, a bare
// `<blockquote>` from Outlook/Yahoo, or Apple Mail's `<blockquote
// type="cite">`). splitQuotedHtml finds that boundary and returns the two
// RAW halves as strings — it does not sanitize anything itself. Both halves
// MUST still be passed through sanitizeEmailHtml before they ever reach an
// iframe; see EmailBody below, which always does so for both sanitizedNew
// and sanitizedQuoted.
const QUOTE_MARKER_SELECTOR = "blockquote, .gmail_quote, [type='cite']";

// Elements that carry visible meaning even with empty text content — an
// <img>, a divider, a table used for layout, embedded media. Used below to
// decide whether content "before" or "after" a candidate quote boundary is
// genuinely there, as opposed to stray whitespace or an empty <br>.
const VISUALLY_MEANINGFUL_EMPTY_TAGS = "img, hr, table, input, iframe, video, audio, canvas, svg";

function isMeaningfulNode(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").trim().length > 0;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element;
    if (element.matches(VISUALLY_MEANINGFUL_EMPTY_TAGS)) return true;
    return (element.textContent ?? "").trim().length > 0;
  }
  return false;
}

function hasMeaningfulContent(container: Element): boolean {
  return Array.from(container.childNodes).some(isMeaningfulNode);
}

function hasMeaningfulSiblingsAfter(node: ChildNode): boolean {
  let sibling = node.nextSibling;
  while (sibling) {
    if (isMeaningfulNode(sibling)) return true;
    sibling = sibling.nextSibling;
  }
  return false;
}

/**
 * A quote-semantic element only counts as a splittable TRAILING quote when
 * nothing meaningful follows it anywhere between here and the end of the
 * message — checked at every ancestor level up to (not including) <body>.
 * An inline <blockquote> with real new content after it (a Gmail "quote"
 * composer button, a pasted quote) fails this check and must not hide that
 * content — see GH #91 follow-up.
 */
function isTrailingQuote(splitNode: Element, body: HTMLElement): boolean {
  let current: ChildNode = splitNode;
  for (;;) {
    const parent = current.parentElement;
    if (!parent) return true; // detached — shouldn't happen, fail open to "trailing"
    if (hasMeaningfulSiblingsAfter(current)) return false;
    if (parent === body) return true;
    current = parent;
  }
}

/**
 * Splits raw (unsanitized) bodyHtml into `{ newHtml, quotedHtml }` at a
 * detected quote boundary (see QUOTE_MARKER_SELECTOR). Parsing happens in a
 * detached document — the same safe pattern already used by
 * isEffectivelyPlainText/extractTextFromTrivialHtml/extractReferencedCids —
 * so this never executes anything in the raw, untrusted HTML; it only reads
 * and reorders DOM nodes to decide where the split falls.
 *
 * Algorithm:
 *  1. Find the first quote-semantic element (a <blockquote>, .gmail_quote,
 *     or [type="cite"]). None found -> no split.
 *  2. Absorb NESTED quote-semantic wrappers only (Gmail wraps the "On ...
 *     wrote:" line and the <blockquote> together in an outer <div
 *     class="gmail_quote">) — climb up WHILE the parent is itself
 *     quote-semantic. This deliberately never climbs into a generic wrapper
 *     (e.g. a bare `<div dir="ltr">` holding both the reply and the quote)
 *     — see isTrailingQuote's doc comment for why a generic wrapper must
 *     not become the split point.
 *  3. The candidate is only a real trailing quote if isTrailingQuote holds
 *     — otherwise this isn't a "the rest of the message is quoted" split at
 *     all (an inline quote with real content after it), so no split.
 *  4. Move the quote element out of its original position into its own
 *     container. Because the move happens IN PLACE, everything that was
 *     before it — including earlier siblings inside a shared wrapper div —
 *     stays in newHtml exactly where it was.
 *  5. If that leaves newHtml with no meaningful content at all (the whole
 *     message WAS the quote), revert entirely: return the untouched input
 *     as newHtml and an empty quotedHtml, so an all-quote message renders
 *     normally instead of an empty iframe behind a toggle hiding
 *     everything.
 */
function splitQuotedHtml(rawHtml: string): { newHtml: string; quotedHtml: string } {
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  const marker = doc.body.querySelector(QUOTE_MARKER_SELECTOR);
  if (!marker) return { newHtml: rawHtml, quotedHtml: "" };

  let splitNode: Element = marker;
  while (splitNode.parentElement && splitNode.parentElement.matches(QUOTE_MARKER_SELECTOR)) {
    splitNode = splitNode.parentElement;
  }

  if (!isTrailingQuote(splitNode, doc.body)) {
    return { newHtml: rawHtml, quotedHtml: "" };
  }

  const quotedContainer = doc.createElement("div");
  quotedContainer.appendChild(splitNode); // moves it out of its original position, in place

  if (!hasMeaningfulContent(doc.body)) {
    // All-quote message: nothing meaningful is left in newHtml. Fall back
    // to rendering the original body untouched rather than an empty iframe.
    return { newHtml: rawHtml, quotedHtml: "" };
  }

  return { newHtml: doc.body.innerHTML, quotedHtml: quotedContainer.innerHTML };
}

function isPlainTextQuoteLine(line: string): boolean {
  return /^\s*>/.test(line);
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * Finds the line index where a plain-text quote trail begins, or -1 if
 * none is detected.
 *
 * An explicit reply-separator line ("On ... wrote:", "-----Original
 * Message-----", ...) is an unambiguous signal — the first one found wins,
 * whatever follows it. Detection is shared with the server's own quote-trail
 * stripping (see isQuoteSeparatorLine in @webmail/shared) — GH #168: this
 * used to be a separate, hand-rolled check here that had already drifted
 * from the server's version (missing case-insensitivity on the Spanish
 * separator, and requiring exactly one space in the Outlook banner).
 *
 * A `>`-quoted line is far more ambiguous (a code snippet, a shell prompt
 * "> npm run build", a numeric comparison "> 5" can all start a line with
 * '>') — it's only treated as a real quote boundary when the run of
 * quoted/blank lines starting there reaches the END of the message. If any
 * genuine (non-quoted, non-blank) content follows a '>' line anywhere, that
 * line is a false positive and must not truncate the message — see GH #91
 * follow-up.
 */
function findQuoteSplitIndex(lines: string[]): number {
  const separatorIndex = lines.findIndex((line) => isQuoteSeparatorLine(line));
  if (separatorIndex !== -1) return separatorIndex;

  for (let i = 0; i < lines.length; i++) {
    if (!isPlainTextQuoteLine(lines[i]!)) continue;
    const reachesEnd = lines.slice(i).every((line) => isPlainTextQuoteLine(line) || isBlankLine(line));
    if (reachesEnd) return i;
  }

  return -1;
}

/**
 * Splits raw plain text into `{ newContent, quotedTrail }` at the first
 * detected quote boundary — see findQuoteSplitIndex. bodyText is never
 * HTML — it's always rendered as a React text child (see the <pre> paths in
 * EmailBody), so unlike splitQuotedHtml this never needs a sanitize step of
 * its own.
 */
function splitQuotedText(bodyText: string): { newContent: string; quotedTrail: string } {
  const lines = bodyText.split("\n");
  const splitIndex = findQuoteSplitIndex(lines);
  if (splitIndex === -1) return { newContent: bodyText, quotedTrail: "" };

  return {
    newContent: lines.slice(0, splitIndex).join("\n").replace(/\s+$/, ""),
    quotedTrail: lines.slice(splitIndex).join("\n"),
  };
}

// GH #270: the email body iframe stays sandboxed with NO scripts and NO
// same-origin access — untrusted email HTML must never run code or reach the
// app's origin/session. It only grants the two popup tokens: with a bare
// sandbox="" the browser BLOCKS the `target="_blank"` every sanitized <a>
// carries (see sanitize.ts), so no link in an HTML email opened at all.
// `allow-popups` lets a click open a new tab and `allow-popups-to-escape-sandbox`
// makes that tab a normal, unsandboxed page — the link opens outside the
// sandbox without ever loosening the sandbox around the email content itself.
// Deliberately does NOT include allow-scripts or allow-same-origin.
const IFRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

// GH #160: srcDoc's own <style> gets an extra `body{zoom:<scale>}` rule
// whenever the email's authored width doesn't fit — see
// detectAuthoredContentWidth/computeEmailScale below for how scale is
// derived. scale === 1 (the overwhelmingly common case — most mail has no
// fixed-width layout wider than the reader) adds no rule at all, so the
// srcdoc stays byte-identical to before this change for ordinary mail.
function wrapDocument(bodyInnerHtml: string, scale: number) {
  const zoomRule = scale < 1 ? `body{zoom:${scale}}` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:${EMAIL_PAPER_COLOR_SCHEME}}html,body{background:${EMAIL_PAPER_PANEL};margin:0}body{padding:2px;color:${EMAIL_PAPER_INK};font-family:"Space Grotesk Variable","Space Grotesk",system-ui,sans-serif;font-size:15px;line-height:1.65}${zoomRule}</style></head><body>${bodyInnerHtml}</body></html>`;
}

// GH #160: wide messages (an ordinary fixed-width marketing table, e.g.
// `<table width="600">`) were clipped mid-word with no horizontal
// scrollbar to reach the rest — the iframe's own box stays capped at its
// container's width (see EmailBody's wrapping div), but nothing shrank the
// content to match. The text was always present in the DOM and
// accessibility tree (a screen reader announced it in full) while a sighted
// user simply had no way to see, or discover, the missing part. GH #135
// solved the orthogonal VERTICAL axis (very long messages, via clip and a
// "view entire message" reveal); the horizontal axis was never covered.
//
// Chosen fix: scale the whole layout down to fit — mirroring how Gmail
// handles fixed-width mail — rather than exposing a horizontal scrollbar.
// A scrollbar would make the content technically reachable, but Chromium's
// overlay scrollbars are invisible until hovered, and nothing else in the
// clipped state hints one exists — silently-discoverable-if-you-happen-to-
// hover is not meaningfully different from invisible. Scaling instead
// guarantees the whole message renders on screen, with nothing left to
// stumble onto.
//
// The scale factor needs the email's own authored (natural) width and the
// container's real available width. The container width IS measurable — it
// is a plain, un-sandboxed element in THIS document (see the ResizeObserver
// wiring in EmailBody below). The sandboxed iframe's actual rendered
// content width is NOT measurable from here (same contentDocument-access
// constraint documented on useContentHeight above), so — like
// BODY_TRUNCATE_TEXT_THRESHOLD — this has to work from the raw HTML string
// itself, before the iframe ever mounts, rather than from a post-render
// measurement. Detection is necessarily best-effort: it looks for the
// single dominant real-world cause (a <table> carrying an explicit pixel
// width, either as the legacy `width` attribute or an inline `width:NNpx`
// style — the standard HTML-email fixed-layout pattern) and takes the
// widest one found. A layout that achieves its fixed width some other way
// (e.g. only via a deeply nested `<td>` width, or a `min-width`) is not
// detected and is not scaled — a false negative here just leaves today's
// existing (clipped) behavior unchanged for that email, never something
// worse.
function detectAuthoredContentWidth(html: string): number | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let widest: number | null = null;

  for (const table of Array.from(doc.body.querySelectorAll("table"))) {
    const attrValue = table.getAttribute("width")?.trim();
    const attrWidth = attrValue && /^\d+$/.test(attrValue) ? Number(attrValue) : null;

    const styleValue = table.getAttribute("style") ?? "";
    const styleMatch = styleValue.match(/(?:^|;)\s*width\s*:\s*(\d+)px/i);
    const styleWidth = styleMatch ? Number(styleMatch[1]) : null;

    const candidate = Math.max(attrWidth ?? 0, styleWidth ?? 0) || null;
    if (candidate && (widest === null || candidate > widest)) widest = candidate;
  }

  return widest;
}

// Never scales up (a narrow email in a wide reader stays at its natural
// size), and never scales on an unknown container width — an unmeasured
// container (containerWidth === null, e.g. no ResizeObserver support) means
// "we don't know if this fits," and guessing wrong in either direction is
// worse than leaving today's existing behavior in place for that render.
function computeEmailScale(authoredWidth: number | null, containerWidth: number | null): number {
  if (!authoredWidth || !containerWidth || authoredWidth <= containerWidth) return 1;
  return containerWidth / authoredWidth;
}

// Reports the live rendered width of a plain (un-sandboxed) container
// element — unlike the sandboxed iframe's own content, this IS reachable
// from here via ResizeObserver. Guarded for environments without
// ResizeObserver (jsdom has none by default): containerWidth simply stays
// null there, so computeEmailScale above never scales on a guess.
function useContainerWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { containerRef: ref, containerWidth: width };
}

/**
 * Measures the iframe's rendered content height via onLoad. sandbox=""
 * without allow-same-origin gives the srcdoc document an opaque origin, so
 * contentDocument is unreachable from real sandboxed browsers by design —
 * loosening that would weaken the iframe's isolation of untrusted email
 * HTML, so it stays as-is. The measurement is therefore best-effort: it
 * only succeeds where the sandbox doesn't enforce cross-origin isolation,
 * and falls back to FALLBACK_HEIGHT everywhere else.
 */
function useContentHeight(resetKey: string): {
  height: string;
  // The real measured px when contentDocument was reachable, else null. GH
  // #276 clips on this when present (the true rendered height), falling back
  // to a pre-mount estimate when it's null (the common opaque-origin case).
  measuredHeight: number | null;
  onLoad: (event: SyntheticEvent<HTMLIFrameElement>) => void;
} {
  const [height, setHeight] = useState<string>(FALLBACK_HEIGHT);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);

  useEffect(() => {
    setHeight(FALLBACK_HEIGHT);
    setMeasuredHeight(null);
  }, [resetKey]);

  function onLoad(event: SyntheticEvent<HTMLIFrameElement>) {
    try {
      const measured = event.currentTarget.contentDocument?.documentElement.scrollHeight;
      if (measured) {
        setHeight(`${measured}px`);
        setMeasuredHeight(measured);
      }
    } catch {
      // Cross-origin access blocked by the sandbox — expected, keep the fallback height.
    }
  }

  return { height, measuredHeight, onLoad };
}

/**
 * GH #140: the message the server handed us is a prefix of the real one — it
 * exceeded the per-body budget the thread fetch asks JMAP for (see
 * MAX_BODY_VALUE_BYTES in apps/server/src/modules/mail/router.ts) and was cut.
 * Until this notice existed the cut was invisible: a message ending
 * mid-sentence looked exactly like a message that ends there.
 *
 * It deliberately also warns about the knock-on effect, because that one is
 * the more damaging half and the user is the only one who can avoid it —
 * composer/reply.ts quotes whatever body it was given, so replying from a
 * truncated message carries the truncation forward into the thread.
 */
function TruncatedBodyNotice() {
  const { t } = useTranslation();
  return (
    <div className="mb-2 rounded-md border border-warn/40 bg-soft px-2 py-1.5 text-xs text-warn">
      <p className="font-semibold">{t("mail.bodyTruncated.title")}</p>
      <p className="mt-0.5 text-muted">{t("mail.bodyTruncated.hint")}</p>
    </div>
  );
}

/**
 * Thin wrapper carrying the GH #140 truncation notice above whichever of
 * EmailBodyContent's four render paths (sandboxed HTML iframe, plain-text
 * <pre>, trivial-HTML extraction, empty body) ends up being taken — the notice
 * is about the body as a whole, so pinning it to one path would silently miss
 * the others. The untruncated case returns EmailBodyContent unwrapped so the
 * common path keeps exactly the DOM it had before.
 */
export function EmailBody({ bodyTruncated = false, ...props }: EmailBodyProps) {
  if (!bodyTruncated) return <EmailBodyContent {...props} />;
  return (
    <div>
      <TruncatedBodyNotice />
      <EmailBodyContent {...props} />
    </div>
  );
}

function EmailBodyContent({
  bodyHtml,
  bodyText,
  attachments,
  onInlineImageError,
}: Omit<EmailBodyProps, "bodyTruncated">) {
  const { t } = useTranslation();
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const [quoteRevealed, setQuoteRevealed] = useState(false);
  // GH #135: one-way reveal (mirrors Gmail's own "View entire message" —
  // once you choose to read the whole thing there's no real use case for
  // re-clipping it), unlike quoteRevealed above which is a genuine toggle.
  const [bodyExpanded, setBodyExpanded] = useState(false);

  // Shared toggle affordance for the quoted trail (GH #91) — a small "•••"
  // button that flips between "Mostrar contenido citado" and "Ocultar
  // contenido citado". The "•••" glyph is decorative only (aria-hidden) so
  // the button's accessible name is exactly the translated toggle label.
  // Declared inside the component (closing over t/quoteRevealed) so it
  // doesn't need its own `t` prop typing.
  function renderQuoteToggle() {
    return (
      <button
        type="button"
        onClick={() => setQuoteRevealed((open) => !open)}
        aria-expanded={quoteRevealed}
        className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-muted transition hover:text-ink"
      >
        <span aria-hidden="true">•••</span>
        {quoteRevealed ? t("mail.hideQuotedContent") : t("mail.showQuotedContent")}
      </button>
    );
  }

  // True when bodyHtml carries no real markup — see isEffectivelyPlainText.
  // Such bodies (including the common case of a server-synthesized bodyHtml
  // that's identical to bodyText) render via the auto-sizing text path
  // below instead of the sandboxed iframe, which fits the content exactly
  // instead of leaving a giant empty box sized for HTML that isn't there.
  const isPlainText = useMemo(
    () => bodyHtml != null && isEffectivelyPlainText(bodyHtml, bodyText),
    [bodyHtml, bodyText],
  );

  // Content-ID -> data: URL lookup, resolved by fetching each referenced,
  // safe-image attachment's blob from this (authenticated) parent document
  // — see useResolvedCidImageMap for why that fetch can't happen from
  // inside the sandboxed iframe itself. Built from the FULL raw bodyHtml
  // (pre-split) so cid: images resolve the same whether they land in the
  // new-content half or the quoted-trail half below.
  const { resolvedMap: cidMap, failedCids } = useResolvedCidImageMap(bodyHtml, attachments);

  // GH #275: bubble up the cids that failed to render inline so the parent can
  // keep their attachments reachable as downloadable chips. failedCids is a
  // stable reference across renders unless its contents actually change, so
  // this only re-reports on a real change; the parent guards against a
  // redundant report anyway.
  useEffect(() => {
    onInlineImageError?.(failedCids);
  }, [failedCids, onInlineImageError]);

  // Splits the raw bodyHtml at the first detected quote boundary (GH #91).
  // This is a structural, pre-sanitize split — see splitQuotedHtml. Only
  // genuine HTML (isPlainText false) goes through this path at all; bodyHtml
  // absent, or effectively plain text, fall through to the text path below.
  const htmlSplit = useMemo(() => {
    if (!bodyHtml || isPlainText) return null;
    return splitQuotedHtml(bodyHtml);
  }, [bodyHtml, isPlainText]);

  // Always re-sanitize from the raw halves so toggling allowRemoteImages (or
  // revealing the quote) restores/derives from the original markup, rather
  // than re-processing already-blocked (data-blocked-src) output. Both
  // halves go through the exact same sanitizeEmailHtml call — the split
  // above never bypasses sanitize for either one.
  const sanitizedNew = useMemo(() => {
    if (!htmlSplit) return null;
    return sanitizeEmailHtml(htmlSplit.newHtml, { allowRemoteImages, cidMap });
  }, [htmlSplit, allowRemoteImages, cidMap]);

  const sanitizedQuoted = useMemo(() => {
    if (!htmlSplit || !htmlSplit.quotedHtml.trim()) return null;
    return sanitizeEmailHtml(htmlSplit.quotedHtml, { allowRemoteImages, cidMap });
  }, [htmlSplit, allowRemoteImages, cidMap]);

  const {
    height: newHeight,
    measuredHeight: newMeasuredHeight,
    onLoad: onNewLoad,
  } = useContentHeight(sanitizedNew?.html ?? "");
  const { height: quotedHeight, onLoad: onQuotedLoad } = useContentHeight(sanitizedQuoted?.html ?? "");

  // GH #160: measures the real available width of the (un-sandboxed)
  // wrapping card below, so a fixed-width authored layout can be scaled
  // down to fit it exactly — see wrapDocument/detectAuthoredContentWidth/
  // computeEmailScale above for why this can't be derived from inside the
  // sandboxed iframe itself. Shared by both the new-content and quoted-
  // trail iframes: they render in same-width sibling cards in this reader
  // column, so one measurement serves both.
  const { containerRef, containerWidth } = useContainerWidth();
  const newScale = useMemo(
    () => computeEmailScale(sanitizedNew ? detectAuthoredContentWidth(sanitizedNew.html) : null, containerWidth),
    [sanitizedNew, containerWidth],
  );
  const quotedScale = useMemo(
    () => computeEmailScale(sanitizedQuoted ? detectAuthoredContentWidth(sanitizedQuoted.html) : null, containerWidth),
    [sanitizedQuoted, containerWidth],
  );

  // GH #135/#276: measured on sanitizedNew only — the new-content half of the
  // GH #91 split, never the quoted trail. The quoted trail already has its
  // own single show/hide toggle (renderQuoteToggle); layering a second,
  // independent clipping control on the same content (hidden by the quote
  // toggle, then re-clipped by this one once revealed) would be confusing,
  // so truncation simply never applies there, however long it is.
  //
  // GH #276: decided by rendered height — the real measured px when the
  // sandbox let us read it, otherwise the pre-mount estimate (which counts
  // images, so a tall image-heavy body is caught even with little text).
  const isBodyTooLong = useMemo(() => {
    if (!sanitizedNew) return false;
    if (newMeasuredHeight != null) return newMeasuredHeight > MEASURED_CLIP_HEIGHT_PX;
    return estimateRenderedHeightPx(sanitizedNew.html) > ESTIMATED_CLIP_HEIGHT_PX;
  }, [sanitizedNew, newMeasuredHeight]);
  const isBodyClipped = isBodyTooLong && !bodyExpanded;

  // Plain-text counterpart of the HTML split above — used only when the
  // sandboxed-iframe path isn't taken (see the `if (sanitizedNew)` branch).
  const textSplit = useMemo(() => (bodyText ? splitQuotedText(bodyText) : null), [bodyText]);

  if (sanitizedNew) {
    // A remote image blocked inside the (currently hidden) quoted trail
    // shouldn't surface "Cargar imágenes" until the user actually reveals
    // it — only count it once quoteRevealed is true.
    const hasBlockedRemoteImages =
      sanitizedNew.hasRemoteImages || (quoteRevealed && Boolean(sanitizedQuoted?.hasRemoteImages));

    return (
      <div>
        {hasBlockedRemoteImages && !allowRemoteImages && (
          <button
            type="button"
            onClick={() => setAllowRemoteImages(true)}
            className="mb-2 rounded-md border border-warn/40 bg-soft px-2 py-1 text-xs text-warn"
          >
            {t("mail.loadImages")}
          </button>
        )}
        {/* Hairline border + radius so the always-light email "paper" reads
            as an intentional document card rather than a floating white box
            against a dark app panel (most noticeable in night theme). */}
        <div ref={containerRef} className="relative overflow-hidden rounded-[10px] border border-line">
          {/* GH #135: srcDoc is ALWAYS the full sanitized document — clipping
              is purely a presentational height/scroll change on this SAME
              iframe, never a second, smaller render of different markup.
              Expanding therefore can never reveal anything sanitize hasn't
              already processed. */}
          <iframe
            sandbox={IFRAME_SANDBOX}
            srcDoc={wrapDocument(sanitizedNew.html, newScale)}
            onLoad={onNewLoad}
            title={t("mail.emailContent")}
            style={{ height: isBodyClipped ? CLIPPED_BODY_HEIGHT : newHeight }}
            scrolling={isBodyClipped ? "no" : "auto"}
            className="block w-full"
          />
          {isBodyClipped && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-14"
              // Always fades to the same white "paper" the iframe itself is
              // painted on (see EMAIL_PAPER_PANEL) — never the app's own
              // (possibly dark) panel color, or the fade would visibly seam
              // against the always-light email content underneath it.
              style={{ background: `linear-gradient(to top, ${EMAIL_PAPER_PANEL}, transparent)` }}
            />
          )}
        </div>
        {isBodyClipped && (
          <button
            type="button"
            onClick={() => setBodyExpanded(true)}
            aria-expanded={false}
            className="mt-2 text-xs font-semibold text-accent-text transition hover:underline"
          >
            {t("mail.showFullMessage")}
          </button>
        )}
        {sanitizedQuoted && (
          <>
            {renderQuoteToggle()}
            {quoteRevealed && (
              <div className="mt-2 overflow-hidden rounded-[10px] border border-line">
                <iframe
                  sandbox={IFRAME_SANDBOX}
                  srcDoc={wrapDocument(sanitizedQuoted.html, quotedScale)}
                  onLoad={onQuotedLoad}
                  title={t("mail.emailContent")}
                  style={{ height: quotedHeight }}
                  className="block w-full"
                />
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  if (textSplit) {
    const hasQuotedTrail = textSplit.quotedTrail.trim().length > 0;
    return (
      <div>
        <pre className="whitespace-pre-wrap text-[15px] leading-[1.65]">{textSplit.newContent}</pre>
        {hasQuotedTrail && (
          <>
            {renderQuoteToggle()}
            {quoteRevealed && (
              <pre className="mt-2 whitespace-pre-wrap text-[15px] leading-[1.65]">{textSplit.quotedTrail}</pre>
            )}
          </>
        )}
      </div>
    );
  }

  // bodyHtml was trivial (isPlainText) but there was no bodyText to fall
  // back on — extract readable text from the trivial markup itself rather
  // than showing an empty body for content that does have something to say.
  if (bodyHtml && isPlainText) {
    const extracted = extractTextFromTrivialHtml(bodyHtml);
    if (extracted) {
      return <pre className="whitespace-pre-wrap text-[15px] leading-[1.65]">{extracted}</pre>;
    }
  }

  return <p className="text-sm text-muted">{t("mail.emptyBody")}</p>;
}
