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

  it("wraps the iframe in a bordered, rounded paper card so it reads as a document instead of a floating box", () => {
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    const wrapper = getIframe().parentElement;
    expect(wrapper?.className).toMatch(/\bborder-line\b/);
    expect(wrapper?.className).toMatch(/rounded-/);
  });

  it("always renders the iframe srcdoc on light paper values (ink/panel/color-scheme) when the app theme is night", () => {
    document.documentElement.dataset.theme = "night";
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    const srcDoc = getIframe().getAttribute("srcdoc") ?? "";

    // Styled marketing HTML assumes a light background (Gmail/Outlook
    // "paper" approach) — the iframe canvas must stay light even though the
    // app is in night theme, or the email's own dark text becomes
    // dark-on-dark and unreadable (the newsletter-night.png regression).
    expect(srcDoc).toContain("#101318");
    expect(srcDoc).toContain("color-scheme:light");
    expect(srcDoc).toContain("background:#ffffff");
    expect(srcDoc).toContain("font-size:15px");
    expect(srcDoc).toContain("line-height:1.65");
    expect(srcDoc).not.toContain("#eceef4");
    expect(srcDoc).not.toContain("color-scheme:dark");
    expect(srcDoc).not.toContain("background:#12141c");
    expect(srcDoc).not.toMatch(/font-family:\s*sans-serif/);
  });

  it("always renders the iframe srcdoc on light paper values (ink/panel/color-scheme) when the app theme is light", () => {
    document.documentElement.dataset.theme = "light";
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    const srcDoc = getIframe().getAttribute("srcdoc") ?? "";

    expect(srcDoc).toContain("#101318");
    expect(srcDoc).toContain("color-scheme:light");
    expect(srcDoc).toContain("background:#ffffff");
  });

  it("keeps the srcdoc on light paper values even when data-theme changes after mount (the iframe no longer follows the app theme)", () => {
    document.documentElement.dataset.theme = "night";
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    const beforeSrcDoc = getIframe().getAttribute("srcdoc") ?? "";
    expect(beforeSrcDoc).toContain("color-scheme:light");

    document.documentElement.dataset.theme = "light";

    const afterSrcDoc = getIframe().getAttribute("srcdoc") ?? "";
    expect(afterSrcDoc).toBe(beforeSrcDoc);
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

  it("falls back to a generous, viewport-proportional height without throwing when contentDocument is unreachable (real sandboxed browsers)", () => {
    render(<EmailBody bodyHtml="<p>Hello</p>" bodyText={null} />);
    const iframe = getIframe();
    stubContentDocument(iframe, null);

    expect(() => fireEvent.load(iframe)).not.toThrow();
    // Regression guard for OSCURO-04: the old fallback was a squat 200px
    // fixed box. The new fallback scales with the viewport instead of a
    // small fixed constant.
    expect(iframe.style.height).not.toBe("200px");
    expect(iframe.style.height).toContain("vh");
  });

  it("raises the plain-text fallback to 15px", () => {
    render(<EmailBody bodyHtml={null} bodyText="Plain text body" />);
    const pre = screen.getByText("Plain text body");
    expect(pre.tagName).toBe("PRE");
    expect(pre.className).toContain("text-[15px]");
    expect(pre.className).not.toContain("text-sm");
  });

  it("keeps the plain-text fallback theme-correct by inheriting page color/background instead of hardcoding its own", () => {
    // Unlike the iframe path, plain text renders directly in the app's own
    // DOM (see index.css `body { color: var(--ink); background: var(--bg) }`),
    // so it must NOT set its own color/background — doing so would re-create
    // the OSCURO-01-style theme mismatch outside the iframe.
    render(<EmailBody bodyHtml={null} bodyText="Plain text body" />);
    const pre = screen.getByText("Plain text body");
    expect(pre.style.color).toBe("");
    expect(pre.style.background).toBe("");
    expect(pre.className).not.toMatch(/\btext-(ink|muted|white|black)\b/);
    expect(pre.className).not.toMatch(/\bbg-/);
  });

  describe("inline cid attachments", () => {
    it("builds a cid map from the attachments prop and rewrites a matching cid: image to its blob URL", () => {
      render(
        <EmailBody
          bodyHtml={`<p>hi</p><img src="cid:logo123">`}
          bodyText={null}
          attachments={[
            { blobId: "b1", name: "logo.png", type: "image/png", size: 10, cid: "logo123" },
          ]}
        />,
      );
      const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
      expect(srcDoc).toContain("/api/mail/blobs/b1?name=logo.png");
      expect(srcDoc).not.toContain("cid:logo123");
    });

    it("ignores attachments without a cid when building the map", () => {
      render(
        <EmailBody
          bodyHtml={`<img src="cid:logo123">`}
          bodyText={null}
          attachments={[{ blobId: "b1", name: "report.pdf", type: "application/pdf", size: 10, cid: null }]}
        />,
      );
      const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
      expect(srcDoc).toContain("cid:logo123");
    });

    it("leaves cid: images untouched when no attachments prop is passed at all", () => {
      render(<EmailBody bodyHtml={`<img src="cid:logo123">`} bodyText={null} />);
      const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
      expect(srcDoc).toContain("cid:logo123");
    });
  });
});
