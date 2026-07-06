import DOMPurify from "dompurify";

export type SanitizedEmail = { html: string; hasRemoteImages: boolean };

const REMOTE_URL_PATTERN = /^https?:\/\//i;

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
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src && REMOTE_URL_PATTERN.test(src)) {
      hasRemoteImages = true;
      if (!options.allowRemoteImages) {
        img.removeAttribute("src");
        // Percent-encode the original URL rather than storing it verbatim:
        // it stays recoverable (decodeURIComponent) for a future "load
        // images" opt-in, but the raw tracking URL never appears as a
        // plain substring in the sanitized output (e.g. in logs, copy-paste,
        // or naive URL scanners).
        img.setAttribute("data-blocked-src", encodeURIComponent(src));
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
