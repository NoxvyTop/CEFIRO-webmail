import DOMPurify from "dompurify";

export type SanitizedEmail = { html: string; hasRemoteImages: boolean };

// Minimal attachment info needed to build the inline blob URL for a
// cid:-referenced image — sourced from server-provided attachment metadata,
// never from the email's own (untrusted) HTML.
export type CidAttachmentInfo = { blobId: string; name: string | null; type: string };

// Matches absolute http(s) URLs and protocol-relative URLs (e.g. //evil.test/x.png),
// which browsers resolve using the current page's protocol and are just as capable
// of leaking a tracking pixel as a fully-qualified https:// URL.
const REMOTE_URL_PATTERN = /^(https?:)?\/\//i;
const CSS_REMOTE_URL_PATTERN = /url\(\s*['"]?\s*(https?:)?\/\//i;

// The "cid:" URI scheme (RFC 2392) referencing a Content-ID body part —
// case-insensitive per the URI spec.
const CID_SCHEME_PATTERN = /^cid:/i;

function extractSrcsetCandidates(srcset: string): string[] {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter((url): url is string => Boolean(url));
}

// Some mail authoring tools wrap the Content-ID in angle brackets even inside
// the src attribute (mirroring the raw Content-ID header syntax), e.g.
// cid:<logo123>. Strip them so the id matches the server's cid (which never
// includes brackets).
function stripAngleBrackets(value: string): string {
  return value.replace(/^</, "").replace(/>$/, "");
}

function cidFromSrc(src: string): string | null {
  if (!CID_SCHEME_PATTERN.test(src)) return null;
  return stripAngleBrackets(src.slice(4));
}

function inlineBlobUrl(attachment: CidAttachmentInfo): string {
  const name = encodeURIComponent(attachment.name ?? "");
  const type = encodeURIComponent(attachment.type);
  // No dl=1 — this must resolve inline (it's an embedded image, not a download).
  return `/api/mail/blobs/${encodeURIComponent(attachment.blobId)}?name=${name}&type=${type}`;
}

/**
 * Finds every cid:-referenced image in the (untrusted, unsanitized) raw HTML
 * and returns the set of referenced content ids. Used by ThreadView to
 * de-duplicate inline images out of the attachment chip list — parsing via
 * DOMParser only reads attributes into a detached document, it never
 * executes scripts, so this is safe to run on raw email HTML.
 */
export function extractReferencedCids(html: string | null | undefined): Set<string> {
  const cids = new Set<string>();
  if (!html) return cids;

  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    const cid = src ? cidFromSrc(src) : null;
    if (cid) cids.add(cid);
  }
  return cids;
}

export function sanitizeEmailHtml(
  raw: string,
  options: { allowRemoteImages: boolean; cidMap?: Record<string, CidAttachmentInfo> },
): SanitizedEmail {
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["form", "input", "button"],
  });

  const doc = new DOMParser().parseFromString(clean, "text/html");

  let hasRemoteImages = false;

  // Rewrite cid: image sources to their inline blob URL first. This is
  // independent of the remote-image block below: embedded inline images are
  // not a tracking vector (they're already part of the message payload the
  // user received, not a fetch to a third party), so they always resolve —
  // no "load images" opt-in gate. Only <img src> is handled (not <source>/
  // srcset): a Content-ID always names one specific resource, not a set of
  // responsive candidates.
  if (options.cidMap) {
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      const src = img.getAttribute("src");
      const cid = src ? cidFromSrc(src) : null;
      if (!cid) continue;
      const attachment = options.cidMap[cid];
      if (attachment) {
        img.setAttribute("src", inlineBlobUrl(attachment));
      }
      // No matching attachment: leave the cid: src verbatim. This is an
      // authoring error in the source email (it references a Content-ID
      // that isn't among this email's attachments) — the browser shows a
      // broken image icon, same as before this fix, rather than us
      // guessing at a fallback or silently hiding the img.
    }
  }

  for (const el of Array.from(doc.querySelectorAll("img, source"))) {
    const src = el.getAttribute("src");
    const srcset = el.getAttribute("srcset");
    const srcsetCandidates = srcset ? extractSrcsetCandidates(srcset) : [];

    const srcIsRemote = Boolean(src && REMOTE_URL_PATTERN.test(src));
    const remoteSrcsetCandidate = srcsetCandidates.find((url) => REMOTE_URL_PATTERN.test(url));

    if (srcIsRemote || remoteSrcsetCandidate) {
      hasRemoteImages = true;
      if (!options.allowRemoteImages) {
        const original = srcIsRemote ? (src as string) : remoteSrcsetCandidate;
        if (srcIsRemote) el.removeAttribute("src");
        if (remoteSrcsetCandidate) el.removeAttribute("srcset");
        // Percent-encode the original URL rather than storing it verbatim:
        // it stays recoverable (decodeURIComponent) for a future "load
        // images" opt-in, but the raw tracking URL never appears as a
        // plain substring in the sanitized output (e.g. in logs, copy-paste,
        // or naive URL scanners).
        if (original) {
          el.setAttribute("data-blocked-src", encodeURIComponent(original));
        }
      }
    }
  }

  for (const el of Array.from(doc.querySelectorAll("[style]"))) {
    const style = el.getAttribute("style");
    if (style && CSS_REMOTE_URL_PATTERN.test(style)) {
      hasRemoteImages = true;
      if (!options.allowRemoteImages) {
        // Conservative: drop the whole style attribute rather than trying to
        // parse/patch individual declarations out of arbitrary CSS text.
        el.removeAttribute("style");
      }
    }
  }

  for (const el of Array.from(doc.querySelectorAll("[background]"))) {
    const background = el.getAttribute("background");
    if (background && REMOTE_URL_PATTERN.test(background)) {
      hasRemoteImages = true;
      if (!options.allowRemoteImages) {
        el.removeAttribute("background");
      }
    }
  }

  for (const link of Array.from(doc.querySelectorAll("a"))) {
    link.removeAttribute("target");
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }

  return { html: doc.body.innerHTML, hasRemoteImages };
}
