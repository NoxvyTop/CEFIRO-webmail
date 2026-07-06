import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "./sanitize";

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
});
