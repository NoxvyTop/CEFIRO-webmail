import DOMPurify from "dompurify";

export type SanitizedEmail = { html: string; hasRemoteImages: boolean };

// Matches absolute http(s) URLs and protocol-relative URLs (e.g. //evil.test/x.png),
// which browsers resolve using the current page's protocol and are just as capable
// of leaking a tracking pixel as a fully-qualified https:// URL.
const REMOTE_URL_PATTERN = /^(https?:)?\/\//i;
const CSS_REMOTE_URL_PATTERN = /url\(\s*['"]?\s*(https?:)?\/\//i;

function extractSrcsetCandidates(srcset: string): string[] {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter((url): url is string => Boolean(url));
}

export function sanitizeEmailHtml(
  raw: string,
  options: { allowRemoteImages: boolean },
): SanitizedEmail {
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["form", "input", "button"],
  });

  const doc = new DOMParser().parseFromString(clean, "text/html");

  let hasRemoteImages = false;

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
