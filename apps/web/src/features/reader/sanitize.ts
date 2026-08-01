import DOMPurify from "dompurify";

export type SanitizedEmail = { html: string; hasRemoteImages: boolean };

// Matches absolute http(s) URLs and protocol-relative URLs (e.g. //evil.test/x.png),
// which browsers resolve using the current page's protocol and are just as capable
// of leaking a tracking pixel as a fully-qualified https:// URL.
const REMOTE_URL_PATTERN = /^(https?:)?\/\//i;

// The three shapes a remote reference takes inside CSS, assembled from shared
// fragments so the inline-[style] check and the <style>-element check can
// never drift apart on which of them they recognise.
//
//  - url(…)          the obvious one, valid anywhere a <url> is.
//  - image-set(…)    GH #224: takes BARE quoted URLs as candidates, with no
//                    url() wrapper — image-set("https://tracker/p.png" 1x) —
//                    so the url() fragment alone never saw it. The legacy
//                    -webkit- prefixed form is still what most mail-authoring
//                    tools emit, and Chromium still honours it.
//  - @import         pulls a whole remote stylesheet and likewise has a
//                    bare-string form (@import "https://…";).
//
// All three fetch the moment the rule applies, so all three leak.
const CSS_URL_REFERENCE = String.raw`url\(\s*['"]?\s*(https?:)?\/\/`;
const CSS_IMAGE_SET_REFERENCE = String.raw`(?:-webkit-)?image-set\(\s*['"]?\s*(https?:)?\/\/`;
const CSS_IMPORT_REFERENCE = String.raw`@import\s+(url\(\s*)?['"]?\s*(https?:)?\/\/`;

const CSS_REMOTE_URL_PATTERN = new RegExp(
  `${CSS_URL_REFERENCE}|${CSS_IMAGE_SET_REFERENCE}`,
  "i",
);
// Everything the inline-[style] pattern covers, plus @import — which is only
// legal inside a stylesheet, never in a style attribute.
const CSS_REMOTE_REFERENCE_PATTERN = new RegExp(
  `${CSS_URL_REFERENCE}|${CSS_IMAGE_SET_REFERENCE}|${CSS_IMPORT_REFERENCE}`,
  "i",
);

// GH #224: attributes the browser fetches as soon as the element renders.
// This used to be just src/srcset on a hard-coded "img, source" query, which
// left <video poster="https://tracker/p.png"> downloading on render — a
// tracking pixel by another name, and enough on its own to defeat the
// remote-image block (GH #182), since the CSP allows img-src https:.
//
// Matching on attribute PRESENCE rather than on a tag list is deliberate and
// fails closed: any element DOMPurify lets through carrying one of these
// attributes is checked, including tags nobody enumerated here.
const REMOTE_FETCH_ATTRIBUTES = ["src", "srcset", "poster"] as const;
const REMOTE_FETCH_SELECTOR = REMOTE_FETCH_ATTRIBUTES.map((name) => `[${name}]`).join(", ");

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

// Neutralises remote references carried inside <style> elements, working on
// the raw parse *before* DOMPurify runs.
//
// This has to happen here, and not in the post-DOMPurify pass below, for two
// reasons. First, the reference lives in the element's text content, so the
// per-attribute [style]/[background] checks never see it. Second — and this is
// why it can't just be another loop after DOMPurify — DOMPurify's handling of
// the <style> tag is environment-dependent: a real browser keeps the element
// (confirmed live: a `background:url(https://…)` fired a request the moment the
// message was opened, defeating the remote-image opt-in, since the CSP allows
// https: images), while jsdom drops it. DOMParser keeps <style> in both, so
// doing it here makes the behaviour identical everywhere and actually testable.
//
// Whole elements are removed rather than their CSS edited, exactly as the
// [style] attribute is dropped whole below: patching arbitrary CSS to excise
// only the remote bits is far more error-prone than removing a block the reader
// chose not to load.
function stripRemoteStyleElements(
  raw: string,
  allowRemoteImages: boolean,
): { html: string; hasRemoteStyle: boolean } {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  let hasRemoteStyle = false;
  for (const styleEl of Array.from(doc.querySelectorAll("style"))) {
    if (!CSS_REMOTE_REFERENCE_PATTERN.test(styleEl.textContent ?? "")) continue;
    hasRemoteStyle = true;
    if (!allowRemoteImages) styleEl.remove();
  }
  // Re-serialise only when something was found, so the common (no-<style>) case
  // pays nothing and passes the original string through untouched. The full
  // documentElement is serialised so a <style> in <head> is covered too.
  if (!hasRemoteStyle) return { html: raw, hasRemoteStyle: false };
  return { html: doc.documentElement.outerHTML, hasRemoteStyle: true };
}

export function sanitizeEmailHtml(
  raw: string,
  // cidMap is cid -> already-resolved src string (a data: URL in production).
  // Resolution — fetching the attachment's blob and building the data: URL —
  // happens in EmailBody, which is the (authenticated) parent document; the
  // email body itself renders inside an opaque-origin sandboxed iframe that
  // can't authenticate a same-origin blob fetch on its own. sanitize just
  // assigns whatever resolved src it's handed; it never constructs URLs.
  options: { allowRemoteImages: boolean; cidMap?: Record<string, string> },
): SanitizedEmail {
  const { html: preprocessed, hasRemoteStyle } = stripRemoteStyleElements(
    raw,
    options.allowRemoteImages,
  );

  const clean = DOMPurify.sanitize(preprocessed, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["form", "input", "button"],
  });

  const doc = new DOMParser().parseFromString(clean, "text/html");

  let hasRemoteImages = hasRemoteStyle;

  // Rewrite cid: image sources to their resolved src first. This is
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
      const resolvedSrc = options.cidMap[cid];
      if (resolvedSrc) {
        img.setAttribute("src", resolvedSrc);
      }
      // No resolved entry: leave the cid: src verbatim. Either this is an
      // authoring error in the source email (it references a Content-ID
      // that isn't among this email's attachments), or the parent's blob
      // fetch for this cid hasn't resolved yet (or isn't a safe image type)
      // — either way the browser shows a broken image icon rather than us
      // guessing at a fallback or silently hiding the img.
    }
  }

  for (const el of Array.from(doc.querySelectorAll(REMOTE_FETCH_SELECTOR))) {
    for (const attribute of REMOTE_FETCH_ATTRIBUTES) {
      const value = el.getAttribute(attribute);
      if (!value) continue;

      // srcset is the one attribute holding a LIST of candidates; every other
      // one is a single URL, so wrapping it keeps a single code path.
      const candidates = attribute === "srcset" ? extractSrcsetCandidates(value) : [value];
      const remoteCandidate = candidates.find((url) => REMOTE_URL_PATTERN.test(url));
      if (!remoteCandidate) continue;

      hasRemoteImages = true;
      if (options.allowRemoteImages) continue;

      el.removeAttribute(attribute);
      // Percent-encode the original URL rather than storing it verbatim: it
      // stays recoverable (decodeURIComponent) for a future "load images"
      // opt-in, but the raw tracking URL never appears as a plain substring
      // in the sanitized output (e.g. in logs, copy-paste, or naive URL
      // scanners). One data-blocked-* per source attribute, so an element
      // carrying several (an <img src+srcset>, a <video src+poster>) doesn't
      // silently drop all but one of them.
      el.setAttribute(`data-blocked-${attribute}`, encodeURIComponent(remoteCandidate));
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

  // Remote references inside <style> elements are handled up front by
  // stripRemoteStyleElements, before DOMPurify — see its comment for why it
  // cannot be another pass here.

  for (const link of Array.from(doc.querySelectorAll("a"))) {
    link.removeAttribute("target");
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }

  return { html: doc.body.innerHTML, hasRemoteImages };
}
