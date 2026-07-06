import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "../reader/sanitize";

describe("RichTextEditor fallback sanitization", () => {
  it("sanitizes remote images in the initial seed", () => {
    const dangerousHtml = '<p>Hello</p><img src="https://evil.test/x.png" />';
    const result = sanitizeEmailHtml(dangerousHtml, { allowRemoteImages: false });

    // The remote image src should be removed and replaced with data-blocked-src
    expect(result.html).not.toMatch(/src="https:\/\/evil\.test/);
    expect(result.html).toMatch(/data-blocked-src=/);
    expect(result.hasRemoteImages).toBe(true);
  });

  it("sanitizes scripts from the initial seed", () => {
    const dangerousHtml = '<p>Hello</p><script>alert("xss")</script>';
    const result = sanitizeEmailHtml(dangerousHtml, { allowRemoteImages: false });

    // Scripts should be completely removed by DOMPurify
    expect(result.html).not.toMatch(/<script>/i);
    expect(result.hasRemoteImages).toBe(false);
  });

  it("allows safe HTML in the initial seed", () => {
    const safeHtml = "<p><strong>Bold text</strong></p>";
    const result = sanitizeEmailHtml(safeHtml, { allowRemoteImages: false });

    // Safe HTML should be preserved
    expect(result.html).toContain("<strong>Bold text</strong>");
    expect(result.hasRemoteImages).toBe(false);
  });
});
