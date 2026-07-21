import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { EmailBody } from "./EmailBody";

function getIframe() {
  return screen.getByTitle(i18n.t("mail.emailContent")) as HTMLIFrameElement;
}

function stubContentDocument(iframe: HTMLIFrameElement, scrollHeight: number | null) {
  Object.defineProperty(iframe, "contentDocument", {
    configurable: true,
    get: () =>
      scrollHeight === null
        ? null
        : { documentElement: { scrollHeight } },
  });
}

beforeEach(() => {
  document.documentElement.dataset.theme = "night";
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("EmailBody", () => {
  it("keeps the sandbox attribute empty (no allow-scripts/allow-same-origin)", () => {
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    expect(getIframe().getAttribute("sandbox")).toBe("");
  });

  it("no longer boxes the body in a white, bordered, fixed-height frame", () => {
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    const iframe = getIframe();
    expect(iframe.className).not.toMatch(/bg-white/);
    expect(iframe.className).not.toMatch(/border/);
    expect(iframe.className).not.toMatch(/h-64/);
  });

  it("injects the night theme ink color, a transparent background, and 15px/1.65 typography", () => {
    document.documentElement.dataset.theme = "night";
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    const srcDoc = getIframe().getAttribute("srcdoc") ?? "";

    expect(srcDoc).toContain("#eceef4");
    expect(srcDoc).toContain("background:transparent");
    expect(srcDoc).toContain("font-size:15px");
    expect(srcDoc).toContain("line-height:1.65");
    expect(srcDoc).not.toContain("color:#111");
    expect(srcDoc).not.toMatch(/font-family:\s*sans-serif/);
  });

  it("injects the light theme ink color when data-theme is light", () => {
    document.documentElement.dataset.theme = "light";
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    const srcDoc = getIframe().getAttribute("srcdoc") ?? "";

    expect(srcDoc).toContain("#101318");
  });

  it("re-injects the current theme's ink color when data-theme changes after mount", async () => {
    document.documentElement.dataset.theme = "night";
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    expect(getIframe().getAttribute("srcdoc") ?? "").toContain("#eceef4");

    document.documentElement.dataset.theme = "light";

    await waitFor(() => {
      expect(getIframe().getAttribute("srcdoc") ?? "").toContain("#101318");
    });
  });

  it("resizes to the measured content height when the sandbox permits contentDocument access", async () => {
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    const iframe = getIframe();
    stubContentDocument(iframe, 420);

    fireEvent.load(iframe);

    await waitFor(() => {
      expect(iframe.style.height).toBe("420px");
    });
  });

  it("falls back to a default height without throwing when contentDocument is unreachable (real sandboxed browsers)", () => {
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    const iframe = getIframe();
    stubContentDocument(iframe, null);

    expect(() => fireEvent.load(iframe)).not.toThrow();
    expect(iframe.style.height).toMatch(/^\d+px$/);
  });

  it("raises the plain-text fallback to 15px", () => {
    render(<EmailBody bodyHtml={null} bodyText="Plain text body" />);
    const pre = screen.getByText("Plain text body");
    expect(pre.tagName).toBe("PRE");
    expect(pre.className).toContain("text-[15px]");
    expect(pre.className).not.toContain("text-sm");
  });
});
