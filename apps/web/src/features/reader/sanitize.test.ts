import { describe, expect, it } from "vitest";
import { extractReferencedCids, sanitizeEmailHtml } from "./sanitize";

// HTML attribute serialization escapes "&" to "&amp;", so a multi-query-param
// URL asserted against `out.html` directly would need to account for that.
// Re-parsing and reading the live attribute value sidesteps the escaping
// entirely and asserts what actually ends up in the DOM.
function firstImgSrc(html: string): string | null {
  return new DOMParser().parseFromString(html, "text/html").querySelector("img")?.getAttribute("src") ?? null;
}

describe("sanitizeEmailHtml", () => {
  it("strips scripts and event handlers", () => {
    const out = sanitizeEmailHtml(
      `<p onclick="x()">hi</p><script>steal()</script>`,
      { allowRemoteImages: false },
    );
    expect(out.html).not.toContain("script");
    expect(out.html).not.toContain("onclick");
    expect(out.html).toContain("hi");
  });

  it("blocks remote images by default and flags them", () => {
    const out = sanitizeEmailHtml(
      `<img src="https://tracker.evil/pixel.png"><img src="data:image/png;base64,AAAA">`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("https://tracker.evil");
    expect(out.html).toContain("data-blocked-src");
    expect(out.html).toContain("data:image/png");
  });

  it("keeps remote images when allowed", () => {
    const out = sanitizeEmailHtml(
      `<img src="https://cdn.ok/logo.png">`,
      { allowRemoteImages: true },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).toContain("https://cdn.ok/logo.png");
  });

  it("hardens links", () => {
    const out = sanitizeEmailHtml(
      `<a href="https://x.test">link</a>`,
      { allowRemoteImages: false },
    );
    expect(out.html).toContain(`target="_blank"`);
    expect(out.html).toContain("noopener");
  });

  it("reports no remote images for clean content", () => {
    const out = sanitizeEmailHtml(`<p>plain</p>`, { allowRemoteImages: false });
    expect(out.hasRemoteImages).toBe(false);
  });

  it("blocks srcset on img and source elements", () => {
    const out = sanitizeEmailHtml(
      `<picture><source srcset="https://evil.test/a.png 1x"><img srcset="https://evil.test/b.png 1x, https://evil.test/c.png 2x" src="data:image/png;base64,AA"></picture>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("https://evil.test");
    expect(out.html).toContain("data:image/png");
  });

  it("blocks protocol-relative image urls", () => {
    const out = sanitizeEmailHtml(`<img src="//evil.test/x.png">`, { allowRemoteImages: false });
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("//evil.test");
  });

  it("strips style attributes with remote url() and counts them", () => {
    const out = sanitizeEmailHtml(
      `<div style="background:url('https://evil.test/t.png');color:red">x</div><p style="color:blue">y</p>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("evil.test");
    expect(out.html).toContain(`style="color:blue"`);
  });

  it("keeps data-uri styles and styles without urls", () => {
    const out = sanitizeEmailHtml(
      `<div style="background:url(data:image/png;base64,AA)">x</div>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(false);
    expect(out.html).toContain("data:image/png");
  });

  it("blocks the legacy background attribute", () => {
    const out = sanitizeEmailHtml(
      `<table background="https://evil.test/bg.png"><tr><td>x</td></tr></table>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("evil.test");
  });

  describe("inline cid: images", () => {
    const cidMap = {
      logo123: { blobId: "blob-1", name: "logo.png", type: "image/png" },
    };

    it("rewrites a cid: image src to the matching attachment's inline blob URL", () => {
      const out = sanitizeEmailHtml(`<img src="cid:logo123">`, {
        allowRemoteImages: false,
        cidMap,
      });
      expect(firstImgSrc(out.html)).toBe("/api/mail/blobs/blob-1?name=logo.png&type=image%2Fpng");
      expect(out.html).not.toContain("cid:logo123");
    });

    it("is case-insensitive on the cid: scheme", () => {
      const out = sanitizeEmailHtml(`<img src="CID:logo123">`, {
        allowRemoteImages: false,
        cidMap,
      });
      expect(firstImgSrc(out.html)).toBe("/api/mail/blobs/blob-1?name=logo.png&type=image%2Fpng");
    });

    it("strips angle brackets around the content id before matching", () => {
      const out = sanitizeEmailHtml(`<img src="cid:<logo123>">`, {
        allowRemoteImages: false,
        cidMap,
      });
      expect(firstImgSrc(out.html)).toBe("/api/mail/blobs/blob-1?name=logo.png&type=image%2Fpng");
    });

    it("leaves a cid: image with no matching attachment untouched (authoring error, not ours to fix)", () => {
      const out = sanitizeEmailHtml(`<img src="cid:unknown">`, {
        allowRemoteImages: false,
        cidMap,
      });
      expect(out.html).toContain("cid:unknown");
    });

    it("leaves cid: images untouched when no cidMap is provided", () => {
      const out = sanitizeEmailHtml(`<img src="cid:logo123">`, { allowRemoteImages: false });
      expect(out.html).toContain("cid:logo123");
    });

    it("never flags cid: images as remote — they are embedded content, not tracking, and always resolve", () => {
      const out = sanitizeEmailHtml(`<img src="cid:logo123">`, {
        allowRemoteImages: false,
        cidMap,
      });
      expect(out.hasRemoteImages).toBe(false);
    });

    it("resolves the cid image even when remote images are blocked (no 'Cargar imágenes' gate)", () => {
      const out = sanitizeEmailHtml(
        `<img src="cid:logo123"><img src="https://tracker.evil/pixel.png">`,
        { allowRemoteImages: false, cidMap },
      );
      expect(firstImgSrc(out.html)).toBe("/api/mail/blobs/blob-1?name=logo.png&type=image%2Fpng");
      // The remote image is still blocked (same convention as the other
      // remote-image tests above): the live src is stripped, so only the
      // percent-encoded data-blocked-src remains.
      expect(out.html).not.toContain("https://tracker.evil");
    });
  });
});

describe("extractReferencedCids", () => {
  it("returns the set of content ids referenced by cid: images in the body", () => {
    const cids = extractReferencedCids(`<p>hi</p><img src="cid:logo123">`);
    expect(cids).toEqual(new Set(["logo123"]));
  });

  it("is case-insensitive on the cid: scheme and strips angle brackets", () => {
    const cids = extractReferencedCids(`<img src="CID:<logo123>">`);
    expect(cids).toEqual(new Set(["logo123"]));
  });

  it("collects multiple referenced cids", () => {
    const cids = extractReferencedCids(`<img src="cid:a"><img src="cid:b">`);
    expect(cids).toEqual(new Set(["a", "b"]));
  });

  it("ignores non-cid image srcs", () => {
    const cids = extractReferencedCids(`<img src="https://cdn.ok/logo.png">`);
    expect(cids).toEqual(new Set());
  });

  it("returns an empty set for null or empty html", () => {
    expect(extractReferencedCids(null)).toEqual(new Set());
    expect(extractReferencedCids("")).toEqual(new Set());
  });
});
