import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { sanitizeEmailHtml } from "../reader/sanitize";
import { isSafeLinkUrl, RichTextEditor } from "./RichTextEditor";

describe("isSafeLinkUrl", () => {
  it.each(["https://x.test", "http://x.test", "mailto:a@b.com"])(
    "allows safe absolute URL: %s",
    (url) => {
      expect(isSafeLinkUrl(url)).toBe(true);
    },
  );

  it.each([
    ["javascript: protocol", "javascript:alert(1)"],
    ["leading whitespace obfuscation", " javascript:alert(1)"],
    ["embedded tab obfuscation", "java\tscript:alert(1)"],
    ["data: protocol", "data:text/html,<script>alert(1)</script>"],
    ["vbscript: protocol", "vbscript:msgbox(1)"],
    ["relative path", "/foo"],
    ["not a URL", "notaurl"],
  ])("rejects unsafe or non-absolute value (%s): %s", (_label, url) => {
    expect(isSafeLinkUrl(url)).toBe(false);
  });
});

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

describe("RichTextEditor link toolbar", () => {
  it("does not insert a link when the entered URL is javascript:alert(1)", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const linkButton = await screen.findByRole("button", { name: i18n.t("composer.link") });
    fireEvent.click(linkButton);

    const urlInput = await screen.findByRole("textbox", { name: i18n.t("composer.linkUrl") });
    fireEvent.change(urlInput, { target: { value: "javascript:alert(1)" } });
    fireEvent.keyDown(urlInput, { key: "Enter" });

    expect(await screen.findByText(i18n.t("composer.invalidLink"))).toBeInTheDocument();

    const editor = screen.getByRole("textbox", { name: "Message" });
    expect(editor.querySelector("a")).toBeNull();
  });
});
