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
});
