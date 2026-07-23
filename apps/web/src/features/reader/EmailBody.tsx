import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AttachmentMeta } from "@webmail/shared";
import { extractReferencedCids, sanitizeEmailHtml } from "./sanitize";

interface EmailBodyProps {
  bodyHtml: string | null;
  bodyText: string | null;
  attachments?: AttachmentMeta[];
}

// Mirrors the server's SAFE_INLINE_CONTENT_TYPES image subset (see also
// ThreadView's PREVIEWABLE_CONTENT_TYPES). Only these get fetched and
// inlined as data: URLs — a cid: pointing at any other content-type is left
// verbatim (broken image icon), so nothing but a genuine image is ever
// turned into a data: URL.
const SAFE_INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isSafeInlineImage(type: string): boolean {
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
): Record<string, string> {
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

  useEffect(() => {
    let isCurrent = true;

    if (candidates.length === 0) {
      setResolvedMap({});
      return;
    }

    // Clear any previous message's resolved entries immediately so a stale
    // map is never briefly attributed to the new message.
    setResolvedMap({});

    Promise.all(
      candidates.map(async (attachment) => {
        try {
          const dataUrl = await fetchAsDataUrl(attachment.blobId, attachment.name, attachment.type);
          return [attachment.cid, dataUrl] as const;
        } catch {
          // Fetch/network failure: leave this cid unresolved rather than
          // falling back to an unauthenticated (401-prone) blob URL.
          return null;
        }
      }),
    ).then((results) => {
      if (!isCurrent) return;
      const resolved: Record<string, string> = {};
      for (const entry of results) {
        if (entry) resolved[entry[0]] = entry[1];
      }
      setResolvedMap(resolved);
    });

    return () => {
      isCurrent = false;
    };
  }, [candidates]);

  return resolvedMap;
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

function wrapDocument(bodyInnerHtml: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:${EMAIL_PAPER_COLOR_SCHEME}}html,body{background:${EMAIL_PAPER_PANEL};margin:0}body{padding:2px;color:${EMAIL_PAPER_INK};font-family:"Space Grotesk Variable","Space Grotesk",system-ui,sans-serif;font-size:15px;line-height:1.65}</style></head><body>${bodyInnerHtml}</body></html>`;
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
  onLoad: (event: SyntheticEvent<HTMLIFrameElement>) => void;
} {
  const [height, setHeight] = useState<string>(FALLBACK_HEIGHT);

  useEffect(() => {
    setHeight(FALLBACK_HEIGHT);
  }, [resetKey]);

  function onLoad(event: SyntheticEvent<HTMLIFrameElement>) {
    try {
      const measured = event.currentTarget.contentDocument?.documentElement.scrollHeight;
      if (measured) setHeight(`${measured}px`);
    } catch {
      // Cross-origin access blocked by the sandbox — expected, keep the fallback height.
    }
  }

  return { height, onLoad };
}

export function EmailBody({ bodyHtml, bodyText, attachments }: EmailBodyProps) {
  const { t } = useTranslation();
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);

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
  // inside the sandboxed iframe itself.
  const cidMap = useResolvedCidImageMap(bodyHtml, attachments);

  const sanitized = useMemo(() => {
    // Only genuine HTML (isPlainText false) goes through the sandboxed
    // iframe. bodyHtml absent, or effectively plain text, both fall through
    // to the text path below — the iframe/sandbox is unchanged for real
    // HTML, it's just no longer used for content that has no real markup.
    if (!bodyHtml || isPlainText) return null;
    // Always re-sanitize from the original raw bodyHtml so toggling
    // allowRemoteImages restores the images that were stripped, rather than
    // re-processing already-blocked (data-blocked-src) markup.
    return sanitizeEmailHtml(bodyHtml, { allowRemoteImages, cidMap });
  }, [bodyHtml, isPlainText, allowRemoteImages, cidMap]);

  const { height, onLoad } = useContentHeight(sanitized?.html ?? "");

  if (sanitized) {
    return (
      <div>
        {sanitized.hasRemoteImages && !allowRemoteImages && (
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
        <div className="overflow-hidden rounded-[10px] border border-line">
          <iframe
            sandbox=""
            srcDoc={wrapDocument(sanitized.html)}
            onLoad={onLoad}
            title={t("mail.emailContent")}
            style={{ height }}
            className="block w-full"
          />
        </div>
      </div>
    );
  }

  if (bodyText) {
    return <pre className="whitespace-pre-wrap text-[15px] leading-[1.65]">{bodyText}</pre>;
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
