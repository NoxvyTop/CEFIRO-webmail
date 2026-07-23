import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { EmailBody, isEffectivelyPlainText } from "./EmailBody";

// Genuine markup fixture: a <p> carrying a style attribute is real HTML per
// isEffectivelyPlainText's allowlist (a bare, attribute-free <p> would be
// classified as trivial/plain-text and routed to the <pre> path instead —
// these tests exercise iframe/sandbox mechanics specifically, so the fixture
// must never be trivial).
const HTML_BODY = '<p style="margin:0">Hello</p>';

// A 1x1 transparent PNG's raw bytes — enough to exercise the real fetch ->
// arrayBuffer -> base64 pipeline without a fixture file.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

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

describe("isEffectivelyPlainText", () => {
  it("treats a bodyHtml that is trivially the same as bodyText as plain text", () => {
    expect(isEffectivelyPlainText("Te paso todo el paquete.", "Te paso todo el paquete.")).toBe(true);
  });

  it("treats bare, attribute-free <p> and <br> wrappers as plain text", () => {
    expect(isEffectivelyPlainText("<p>Hello</p>", null)).toBe(true);
    expect(isEffectivelyPlainText("Line1<br>Line2", null)).toBe(true);
    expect(isEffectivelyPlainText("<div><p>Hello</p><br></div>", null)).toBe(true);
  });

  it("treats an empty or null bodyHtml as plain text", () => {
    expect(isEffectivelyPlainText("", null)).toBe(true);
    expect(isEffectivelyPlainText(null, null)).toBe(true);
    expect(isEffectivelyPlainText(undefined, null)).toBe(true);
    expect(isEffectivelyPlainText("   ", null)).toBe(true);
  });

  it("treats an <img> as real markup", () => {
    expect(isEffectivelyPlainText('<img src="https://example.test/x.png">', null)).toBe(false);
  });

  it("treats a <table> as real markup", () => {
    expect(isEffectivelyPlainText("<table><tr><td>Hello</td></tr></table>", null)).toBe(false);
  });

  it("treats an <a> link as real markup", () => {
    expect(isEffectivelyPlainText('<a href="https://example.test">click</a>', null)).toBe(false);
  });

  it("treats a heading as real markup", () => {
    expect(isEffectivelyPlainText("<h1>Title</h1>", null)).toBe(false);
  });

  it("treats a style attribute on an otherwise-trivial tag as real markup", () => {
    expect(isEffectivelyPlainText('<p style="color:red">Hello</p>', null)).toBe(false);
  });

  it("treats a class attribute on an otherwise-trivial tag as real markup", () => {
    expect(isEffectivelyPlainText('<div class="callout">Hello</div>', null)).toBe(false);
  });

  it("does not misclassify a plain-text message with a stray angle bracket as real markup", () => {
    // "< 10" has no letter immediately after "<", so HTML5 parsing keeps it
    // as inert text rather than starting a tag.
    expect(isEffectivelyPlainText("5 < 10 and 10 > 5", "5 < 10 and 10 > 5")).toBe(true);
  });
});

describe("EmailBody", () => {
  it("keeps the sandbox attribute empty (no allow-scripts/allow-same-origin)", () => {
    render(<EmailBody bodyHtml={HTML_BODY} bodyText={null} />);
    expect(getIframe().getAttribute("sandbox")).toBe("");
  });

  it("no longer boxes the body in a white, bordered, fixed-height frame", () => {
    render(<EmailBody bodyHtml={HTML_BODY} bodyText={null} />);
    const iframe = getIframe();
    expect(iframe.className).not.toMatch(/bg-white/);
    expect(iframe.className).not.toMatch(/border/);
    expect(iframe.className).not.toMatch(/h-64/);
  });

  it("wraps the iframe in a bordered, rounded paper card so it reads as a document instead of a floating box", () => {
    render(<EmailBody bodyHtml={HTML_BODY} bodyText={null} />);
    const wrapper = getIframe().parentElement;
    expect(wrapper?.className).toMatch(/\bborder-line\b/);
    expect(wrapper?.className).toMatch(/rounded-/);
  });

  it("always renders the iframe srcdoc on light paper values (ink/panel/color-scheme) when the app theme is night", () => {
    document.documentElement.dataset.theme = "night";
    render(<EmailBody bodyHtml={HTML_BODY} bodyText={null} />);
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
    render(<EmailBody bodyHtml={HTML_BODY} bodyText={null} />);
    const srcDoc = getIframe().getAttribute("srcdoc") ?? "";

    expect(srcDoc).toContain("#101318");
    expect(srcDoc).toContain("color-scheme:light");
    expect(srcDoc).toContain("background:#ffffff");
  });

  it("keeps the srcdoc on light paper values even when data-theme changes after mount (the iframe no longer follows the app theme)", () => {
    document.documentElement.dataset.theme = "night";
    render(<EmailBody bodyHtml={HTML_BODY} bodyText={null} />);
    const beforeSrcDoc = getIframe().getAttribute("srcdoc") ?? "";
    expect(beforeSrcDoc).toContain("color-scheme:light");

    document.documentElement.dataset.theme = "light";

    const afterSrcDoc = getIframe().getAttribute("srcdoc") ?? "";
    expect(afterSrcDoc).toBe(beforeSrcDoc);
  });

  it("resizes to the measured content height when the sandbox permits contentDocument access", async () => {
    render(<EmailBody bodyHtml={HTML_BODY} bodyText={null} />);
    const iframe = getIframe();
    stubContentDocument(iframe, 420);

    fireEvent.load(iframe);

    await waitFor(() => {
      expect(iframe.style.height).toBe("420px");
    });
  });

  it("falls back to a generous, viewport-proportional height without throwing when contentDocument is unreachable (real sandboxed browsers)", () => {
    render(<EmailBody bodyHtml={HTML_BODY} bodyText={null} />);
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

  describe("plain-text routing (OSCURO-04 giant empty box for short/plain emails)", () => {
    it("renders the auto-sizing <pre> path (no iframe) for a server-synthesized bodyHtml that equals bodyText", () => {
      render(<EmailBody bodyHtml="Te paso todo el paquete." bodyText="Te paso todo el paquete." />);
      const pre = screen.getByText("Te paso todo el paquete.");
      expect(pre.tagName).toBe("PRE");
      expect(screen.queryByTitle(i18n.t("mail.emailContent"))).toBeNull();
    });

    it("renders the auto-sizing <pre> path for a trivial bodyHtml (bare <p>) with bodyText present", () => {
      render(<EmailBody bodyHtml="<p>Hello</p>" bodyText="Hello" />);
      const pre = screen.getByText("Hello");
      expect(pre.tagName).toBe("PRE");
      expect(screen.queryByTitle(i18n.t("mail.emailContent"))).toBeNull();
    });

    it("still renders the sandboxed iframe for genuine HTML even when bodyText is also present", () => {
      render(
        <EmailBody
          bodyHtml='<table><tr><td style="color:#333">Formatted</td></tr></table>'
          bodyText="Formatted"
        />,
      );
      expect(getIframe().getAttribute("sandbox")).toBe("");
    });

    it("falls back to the trivial html's own text content in the <pre> when bodyHtml is trivial but there is no bodyText at all", () => {
      render(<EmailBody bodyHtml="<p>Line one</p><p>Line two</p>" bodyText={null} />);
      expect(screen.queryByTitle(i18n.t("mail.emailContent"))).toBeNull();
      const pre = screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent === "Line one\nLine two");
      expect(pre.tagName).toBe("PRE");
    });

    it("shows the empty-body message rather than an empty <pre> when a trivial bodyHtml has no extractable text and no bodyText", () => {
      render(<EmailBody bodyHtml="<br>" bodyText={null} />);
      expect(screen.queryByTitle(i18n.t("mail.emailContent"))).toBeNull();
      expect(screen.getByText(i18n.t("mail.emptyBody"))).toBeTruthy();
    });
  });

  describe("inline cid attachments", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("fetches a referenced, safe-image cid attachment (credentialed) and rewrites its src to a data: URL", async () => {
      const fetchMock = vi.fn(async () => new Response(PNG_BYTES, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      render(
        <EmailBody
          bodyHtml={`<p>hi</p><img src="cid:logo123">`}
          bodyText={null}
          attachments={[
            { blobId: "b1", name: "logo.png", type: "image/png", size: 10, cid: "logo123" },
          ]}
        />,
      );

      await waitFor(() => {
        const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
        expect(srcDoc).toMatch(/src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/mail/blobs/b1?name=logo.png&type=image%2Fpng",
        expect.objectContaining({ credentials: "include" }),
      );
      const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
      expect(srcDoc).not.toContain("cid:logo123");
    });

    it("does not fetch or rewrite a cid: image whose attachment type is not a safe inline image", async () => {
      const fetchMock = vi.fn(async () => new Response(PNG_BYTES, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      render(
        <EmailBody
          bodyHtml={`<img src="cid:doc123">`}
          bodyText={null}
          attachments={[
            { blobId: "b1", name: "report.pdf", type: "application/pdf", size: 10, cid: "doc123" },
          ]}
        />,
      );

      // Let any (incorrect) async fetch have a couple of microtask turns
      // before asserting it never happened.
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).not.toHaveBeenCalled();
      const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
      expect(srcDoc).toContain("cid:doc123");
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

    it("does not let a stale fetch from a previous message overwrite the current message's resolved images (message-change race safety)", async () => {
      let resolveFirstFetch: ((response: Response) => void) | undefined;
      const firstFetchPromise = new Promise<Response>((resolve) => {
        resolveFirstFetch = resolve;
      });

      const fetchMock = vi.fn((url: string) => {
        if (url.includes("first-blob")) return firstFetchPromise;
        return Promise.resolve(new Response(PNG_BYTES, { status: 200 }));
      });
      vi.stubGlobal("fetch", fetchMock);

      const { rerender } = render(
        <EmailBody
          bodyHtml={`<img src="cid:first123">`}
          bodyText={null}
          attachments={[
            { blobId: "first-blob", name: "first.png", type: "image/png", size: 10, cid: "first123" },
          ]}
        />,
      );

      // The message changes (e.g. user opened another thread) before the
      // first message's slow fetch has resolved.
      rerender(
        <EmailBody
          bodyHtml={`<img src="cid:second123">`}
          bodyText={null}
          attachments={[
            { blobId: "second-blob", name: "second.png", type: "image/png", size: 10, cid: "second123" },
          ]}
        />,
      );

      await waitFor(() => {
        const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
        expect(srcDoc).not.toContain("cid:second123");
      });

      // The stale first-message fetch resolves only now, well after the
      // message already moved on.
      resolveFirstFetch?.(new Response(PNG_BYTES, { status: 200 }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
      // A missing race guard would have the stale effect's setState fully
      // replace the resolved-map state with just {first123: ...}, wiping
      // out the current message's already-resolved second123 entry and
      // reverting its <img> back to the unresolved cid: src.
      expect(srcDoc).not.toContain("cid:second123");
      expect(srcDoc).not.toContain("cid:first123");
    });
  });
});
