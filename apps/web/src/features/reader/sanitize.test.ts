import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TiptapTextAlign from "@tiptap/extension-text-align";
import { describe, expect, it } from "vitest";
import { ResizableImage } from "../composer/resizableImageExtension";
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

  // GH #224: the remote-fetch walk used to query "img, source" and read only
  // src/srcset, so a <video poster> downloaded on render and worked as a
  // tracking pixel with the remote-image block (GH #182) fully on.
  describe("media elements that fetch on render (GH #224)", () => {
    it("blocks a remote <video poster>", () => {
      const out = sanitizeEmailHtml(
        `<video poster="https://tracker.evil/p.png"></video>`,
        { allowRemoteImages: false },
      );
      expect(out.hasRemoteImages).toBe(true);
      expect(out.html).not.toContain("https://tracker.evil");
      expect(out.html).toContain("data-blocked-poster");
    });

    it("blocks a protocol-relative <video poster>", () => {
      const out = sanitizeEmailHtml(
        `<video poster="//tracker.evil/p.png"></video>`,
        { allowRemoteImages: false },
      );
      expect(out.hasRemoteImages).toBe(true);
      expect(out.html).not.toContain("//tracker.evil");
    });

    it("keeps a <video poster> once remote images are allowed", () => {
      const out = sanitizeEmailHtml(
        `<video poster="https://cdn.ok/p.png"></video>`,
        { allowRemoteImages: true },
      );
      expect(out.hasRemoteImages).toBe(true);
      expect(out.html).toContain("https://cdn.ok/p.png");
    });

    it("blocks every fetching attribute on one element, not just the first", () => {
      const out = sanitizeEmailHtml(
        `<video src="https://tracker.evil/v.mp4" poster="https://tracker.evil/p.png"></video>`,
        { allowRemoteImages: false },
      );
      expect(out.hasRemoteImages).toBe(true);
      expect(out.html).not.toContain("https://tracker.evil");
      expect(out.html).toContain("data-blocked-src");
      expect(out.html).toContain("data-blocked-poster");
    });

    it("blocks a remote <audio src> and <track src>", () => {
      const out = sanitizeEmailHtml(
        `<audio src="https://tracker.evil/a.mp3"></audio><video><track src="https://tracker.evil/t.vtt"></video>`,
        { allowRemoteImages: false },
      );
      expect(out.hasRemoteImages).toBe(true);
      expect(out.html).not.toContain("https://tracker.evil");
    });
  });

  // GH #224: image-set() takes bare quoted URLs as candidates, with no url()
  // wrapper for the url()-shaped patterns to match on.
  describe("CSS image-set() references (GH #224)", () => {
    it("blocks a remote image-set() in a style attribute", () => {
      const out = sanitizeEmailHtml(
        `<div style="background-image:image-set('https://evil.test/t.png' 1x)">x</div>`,
        { allowRemoteImages: false },
      );
      expect(out.hasRemoteImages).toBe(true);
      expect(out.html).not.toContain("evil.test");
    });

    it("blocks the legacy -webkit-image-set() form in a style attribute", () => {
      const out = sanitizeEmailHtml(
        `<div style="background-image:-webkit-image-set('https://evil.test/t.png' 1x)">x</div>`,
        { allowRemoteImages: false },
      );
      expect(out.hasRemoteImages).toBe(true);
      expect(out.html).not.toContain("evil.test");
    });

    it("blocks a remote image-set() inside a <style> element", () => {
      const out = sanitizeEmailHtml(
        `<style>body{background-image:image-set("https://evil.test/t.png" 1x)}</style><p>hi</p>`,
        { allowRemoteImages: false },
      );
      expect(out.hasRemoteImages).toBe(true);
      expect(out.html).not.toContain("evil.test");
      expect(out.html).toContain("hi");
    });

    it("keeps a data: image-set(), which fetches nothing", () => {
      const out = sanitizeEmailHtml(
        `<div style="background-image:image-set(url(data:image/png;base64,AA) 1x)">x</div>`,
        { allowRemoteImages: false },
      );
      expect(out.hasRemoteImages).toBe(false);
      expect(out.html).toContain("data:image/png");
    });
  });

  // A <style> element carrying a remote url() is a tracking pixel that the
  // per-attribute checks above miss: the remote reference lives in the element's
  // text content, not in a [style]/[background] attribute. Confirmed live — the
  // browser fired the request on open, without opting into remote images (the
  // CSP allows https: images, so only this sanitiser stands in the way).
  //
  // These tests assert exactly two things: the remote reference does not survive
  // into the output, and hasRemoteImages reflects that the message carried one.
  // They deliberately do NOT assert that a *clean* <style> survives — DOMPurify
  // strips every <style> under jsdom regardless of its content (a real browser
  // keeps them), so preservation is a browser-only behaviour this unit
  // environment cannot demonstrate. The security guarantee — no remote leak —
  // is what matters and is what is pinned here.
  it("blocks a <style> element whose CSS references a remote url()", () => {
    const out = sanitizeEmailHtml(
      `<style>body{background:url(https://evil.test/pixel.png)}</style><p>hi</p>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("evil.test");
    expect(out.html).toContain("hi");
  });

  it("blocks a <style> element that pulls a remote stylesheet via @import", () => {
    const out = sanitizeEmailHtml(
      `<style>@import url("https://evil.test/tracker.css");</style><p>hi</p>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("evil.test");
    expect(out.html).toContain("hi");
  });

  it("blocks a bare-string @import in a <style> element", () => {
    const out = sanitizeEmailHtml(
      `<style>@import "https://evil.test/tracker.css";</style><p>hi</p>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("evil.test");
  });

  it("blocks a protocol-relative url() inside a <style> element", () => {
    const out = sanitizeEmailHtml(
      `<style>.x{background:url(//evil.test/p.png)}</style><p>hi</p>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("evil.test");
  });

  it("also finds a remote <style> placed in the document head", () => {
    const out = sanitizeEmailHtml(
      `<head><style>body{background:url(https://evil.test/head.png)}</style></head><body><p>hi</p></body>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(true);
    expect(out.html).not.toContain("evil.test");
  });

  it("does not flag a <style> element whose only url() is a data: URI", () => {
    const out = sanitizeEmailHtml(
      `<style>.x{background:url(data:image/png;base64,AA)}</style><p>hi</p>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(false);
    expect(out.html).not.toContain("evil.test");
  });

  it("does not flag a <style> element with no url() at all", () => {
    const out = sanitizeEmailHtml(
      `<style>p{color:red;font-weight:bold}</style><p>hi</p>`,
      { allowRemoteImages: false },
    );
    expect(out.hasRemoteImages).toBe(false);
  });

  it("reports a remote <style> under the opt-in without stripping it early", () => {
    // Symmetric with remote <img>: when the reader has opted into remote
    // content, the flag still reflects that the message carries some, and the
    // up-front strip is skipped. (Whether the <style> then survives DOMPurify
    // is environment-dependent and not asserted here — see the block above.)
    const out = sanitizeEmailHtml(
      `<style>body{background:url(https://evil.test/pixel.png)}</style>`,
      { allowRemoteImages: true },
    );
    expect(out.hasRemoteImages).toBe(true);
  });

  describe("data: URI images (signature/composer inserted images)", () => {
    // Verifies DOMPurify's default config (USE_PROFILES: { html: true }) does
    // NOT strip data:image/* from <img src>: DOMPurify special-cases the
    // src/href attribute for a fixed set of tags (img, audio, video, source,
    // track) to allow data: URIs regardless of the ALLOWED_URI_REGEXP, since
    // an <img> never executes its src as script the way e.g. an <a href>
    // or <iframe src> could with data:text/html. No sanitizer config change
    // was needed for the signature/composer image-insert feature — this
    // test locks that in so a future DOMPurify upgrade can't silently
    // regress it.
    it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
      "keeps a data:%s image src intact and does not flag it as remote",
      (mime) => {
        const out = sanitizeEmailHtml(`<img src="data:${mime};base64,AAAA">`, {
          allowRemoteImages: false,
        });
        expect(firstImgSrc(out.html)).toBe(`data:${mime};base64,AAAA`);
        expect(out.hasRemoteImages).toBe(false);
      },
    );

    it("still blocks remote http(s) images alongside a kept data: image", () => {
      const out = sanitizeEmailHtml(
        `<img src="data:image/png;base64,AAAA"><img src="https://tracker.evil/pixel.png">`,
        { allowRemoteImages: false },
      );
      expect(out.html).toContain("data:image/png;base64,AAAA");
      expect(out.html).not.toContain("https://tracker.evil");
      expect(out.hasRemoteImages).toBe(true);
    });
  });

  describe("inline cid: images", () => {
    // cidMap is cid -> already-resolved src string (a data: URL in
    // production, built by EmailBody from the trusted attachment blob — see
    // EmailBody.tsx). sanitize never constructs URLs itself; it only assigns
    // whatever resolved src it's handed.
    const cidMap = {
      logo123: "data:image/png;base64,AAAA",
    };

    it("rewrites a cid: image src to the resolved src from cidMap", () => {
      const out = sanitizeEmailHtml(`<img src="cid:logo123">`, {
        allowRemoteImages: false,
        cidMap,
      });
      expect(firstImgSrc(out.html)).toBe("data:image/png;base64,AAAA");
      expect(out.html).not.toContain("cid:logo123");
    });

    it("is case-insensitive on the cid: scheme", () => {
      const out = sanitizeEmailHtml(`<img src="CID:logo123">`, {
        allowRemoteImages: false,
        cidMap,
      });
      expect(firstImgSrc(out.html)).toBe("data:image/png;base64,AAAA");
    });

    it("strips angle brackets around the content id before matching", () => {
      const out = sanitizeEmailHtml(`<img src="cid:<logo123>">`, {
        allowRemoteImages: false,
        cidMap,
      });
      expect(firstImgSrc(out.html)).toBe("data:image/png;base64,AAAA");
    });

    it("leaves a cid: image with no matching entry untouched (unresolved — authoring error or fetch not yet done)", () => {
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
      expect(firstImgSrc(out.html)).toBe("data:image/png;base64,AAAA");
      // The remote image is still blocked (same convention as the other
      // remote-image tests above): the live src is stripped, so only the
      // percent-encoded data-blocked-src remains.
      expect(out.html).not.toContain("https://tracker.evil");
    });
  });

  describe("composer image size/alignment and text-align (RichTextEditor)", () => {
    // Builds the HTML the same way RichTextEditor's toolbar actually would —
    // through a real TipTap editor with the exact same extensions — instead
    // of a hand-typed HTML string, so this test would fail if a future
    // change to the extensions ever emitted markup sanitizeEmailHtml can no
    // longer preserve.
    function composerGeneratedHtml(): string {
      const editor = new Editor({
        extensions: [
          StarterKit,
          ResizableImage.configure({ allowBase64: true }),
          TiptapTextAlign.configure({ types: ["heading", "paragraph"] }),
        ],
        content: "<p>Hello</p>",
      });
      try {
        editor.commands.setTextAlign("center");
        editor.commands.insertContentAt(editor.state.doc.content.size, {
          type: "image",
          attrs: { src: "data:image/png;base64,AAAA", width: "50%", align: "left" },
        });
        return editor.getHTML();
      } finally {
        editor.destroy();
      }
    }

    it("survives DOMPurify with the width/alignment/text-align styles intact", () => {
      const html = composerGeneratedHtml();
      // Sanity check on the fixture itself: if this fails, the assertions
      // below on `out.html` would be meaningless (testing that sanitize
      // preserves content it never received).
      expect(html).toContain("text-align: center");
      expect(html).toContain("width: 50%");
      expect(html).toContain("margin-right: auto"); // align: "left"

      const out = sanitizeEmailHtml(html, { allowRemoteImages: false });

      expect(out.html).toContain("text-align: center");
      expect(out.html).toContain("width: 50%");
      expect(out.html).toContain("margin-right: auto");
      expect(out.hasRemoteImages).toBe(false);
    });

    // Adversarial counterpart to the round-trip test above: locks in that
    // sanitizeEmailHtml's EXISTING remote-url style guard (CSS_REMOTE_URL_PATTERN,
    // unmodified here) still neutralizes a crafted style attribute that
    // smuggles a `url(http...)` payload alongside a legitimate width/align
    // or text-align declaration. Doesn't require any change to sanitize.ts —
    // this is a regression lock against a *future* sanitize.ts change ever
    // narrowing that guard (e.g. someone "fixing" it to only strip the
    // specific bad declaration instead of the whole attribute) in a way that
    // would let the payload through.
    it("strips a crafted image style that smuggles a remote background:url() next to a legitimate width", () => {
      const html = '<img src="data:image/png;base64,AAAA" style="width:50%;background:url(http://evil.com/x)">';

      const out = sanitizeEmailHtml(html, { allowRemoteImages: false });

      expect(out.hasRemoteImages).toBe(true);
      expect(out.html).not.toContain("evil.com");
      expect(out.html).not.toContain("url(");
      // sanitize.ts is conservative: the whole `style` attribute is dropped
      // rather than surgically removing just the bad declaration, so the
      // safe `width: 50%` sitting next to it is lost too — that's the
      // existing, intentional tradeoff this test locks in, not a gap.
      expect(out.html).not.toContain("style=");
    });

    it("strips a crafted paragraph style that smuggles a remote url() next to a legitimate text-align", () => {
      const html = '<p style="text-align:center;background:url(http://evil.com/y)">Hi</p>';

      const out = sanitizeEmailHtml(html, { allowRemoteImages: false });

      expect(out.hasRemoteImages).toBe(true);
      expect(out.html).not.toContain("evil.com");
      expect(out.html).not.toContain("url(");
      expect(out.html).not.toContain("style=");
      expect(out.html).toContain("Hi");
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
