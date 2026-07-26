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

  // GH #91: each reply used to show the full quoted trail inline, repeating
  // the previous message's text down the thread. It's now hidden behind a
  // toggle — detected and split out of the raw body before sanitizing.
  describe("quoted trail (GH #91)", () => {
    const QUOTED_HTML_BODY =
      '<p style="margin:0">New reply content</p>' +
      '<div class="gmail_quote">' +
      '<div class="gmail_attr">On Mon, Jul 20, 2026 at 10:00 AM John Doe &lt;john@example.com&gt; wrote:<br></div>' +
      '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">' +
      '<p style="margin:0">Original message</p>' +
      "</blockquote>" +
      "</div>";

    it("renders only the new content by default and hides the quoted trail behind a toggle", async () => {
      render(<EmailBody bodyHtml={QUOTED_HTML_BODY} bodyText={null} />);

      expect(screen.getAllByTitle(i18n.t("mail.emailContent"))).toHaveLength(1);
      const mainSrcDoc = getIframe().getAttribute("srcdoc") ?? "";
      expect(mainSrcDoc).toContain("New reply content");
      expect(mainSrcDoc).not.toContain("Original message");

      expect(screen.getByRole("button", { name: i18n.t("mail.showQuotedContent") })).toBeInTheDocument();
    });

    it("reveals the quoted trail (through the same sanitized iframe path) when the toggle is clicked", async () => {
      render(<EmailBody bodyHtml={QUOTED_HTML_BODY} bodyText={null} />);

      fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.showQuotedContent") }));

      await waitFor(() => {
        expect(screen.getAllByTitle(i18n.t("mail.emailContent"))).toHaveLength(2);
      });
      const srcDocs = screen
        .getAllByTitle(i18n.t("mail.emailContent"))
        .map((el) => el.getAttribute("srcdoc") ?? "");
      expect(srcDocs.some((doc) => doc.includes("Original message"))).toBe(true);

      expect(screen.getByRole("button", { name: i18n.t("mail.hideQuotedContent") })).toBeInTheDocument();
    });

    it("hides the quoted trail again when the toggle is clicked a second time", async () => {
      render(<EmailBody bodyHtml={QUOTED_HTML_BODY} bodyText={null} />);

      fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.showQuotedContent") }));
      await screen.findByRole("button", { name: i18n.t("mail.hideQuotedContent") });

      fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.hideQuotedContent") }));

      expect(screen.getAllByTitle(i18n.t("mail.emailContent"))).toHaveLength(1);
      expect(screen.getByRole("button", { name: i18n.t("mail.showQuotedContent") })).toBeInTheDocument();
    });

    it("shows no quoted-content toggle for a body with no detected quote", () => {
      render(<EmailBody bodyHtml={HTML_BODY} bodyText={null} />);

      expect(screen.queryByRole("button", { name: i18n.t("mail.showQuotedContent") })).not.toBeInTheDocument();
    });

    it("splits a plain-text body at the first '>'-quoted line and hides it behind the same toggle", async () => {
      const plainBody =
        "New reply content\n\nOn Mon, Jul 20, 2026 at 10:00 AM John Doe wrote:\n> Original message\n> more quoted text";
      render(<EmailBody bodyHtml={null} bodyText={plainBody} />);

      expect(screen.getByText("New reply content")).toBeInTheDocument();
      expect(screen.queryByText(/Original message/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.showQuotedContent") }));

      expect(await screen.findByText(/Original message/)).toBeInTheDocument();
    });

    it("shows no toggle for a plain-text body with no quoted trail", () => {
      render(<EmailBody bodyHtml={null} bodyText="Just a normal message, nothing quoted here." />);

      expect(screen.queryByRole("button", { name: i18n.t("mail.showQuotedContent") })).not.toBeInTheDocument();
    });

    // Follow-up fixes to the boundary heuristic — a real reviewer found two
    // ways the naive "first blockquote/gmail_quote, climb to the top-level
    // ancestor" split could hide genuine new content, plus an over-eager
    // plain-text '>' match.
    describe("boundary heuristic (does not hide genuine new content)", () => {
      it("does not hide new content that follows an inline blockquote that isn't actually a trailing quote", () => {
        // A <blockquote> used inline (Gmail's own "quote" composer button, or
        // a pasted quote) with real new content on BOTH sides — the naive
        // "first blockquote onward" rule would wrongly swallow the paragraph
        // that follows it.
        const inlineBlockquoteBody =
          "<p>Quoting something below:</p>" +
          "<blockquote>inline quoted note</blockquote>" +
          "<p>This is new content after the quote.</p>";

        render(<EmailBody bodyHtml={inlineBlockquoteBody} bodyText={null} />);

        expect(screen.getAllByTitle(i18n.t("mail.emailContent"))).toHaveLength(1);
        const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
        expect(srcDoc).toContain("This is new content after the quote.");
        // Not a trailing quote (real content follows it) — nothing to
        // toggle, the whole body renders exactly as it does today.
        expect(screen.queryByRole("button", { name: i18n.t("mail.showQuotedContent") })).not.toBeInTheDocument();
      });

      it("splits inside a shared wrapper div so the reply text before the quote stays visible as new content", async () => {
        // Real client markup: ONE body-level wrapper (<div dir="ltr">) holds
        // both the reply text and the .gmail_quote — climbing to the
        // top-level ancestor (the wrapper) would empty newHtml entirely.
        const wrappedBody =
          '<div dir="ltr">This is my reply text.' +
          '<div class="gmail_quote">' +
          '<div class="gmail_attr">On Mon, Jul 20, 2026 wrote:<br></div>' +
          '<blockquote class="gmail_quote">Original quoted text</blockquote>' +
          "</div></div>";

        render(<EmailBody bodyHtml={wrappedBody} bodyText={null} />);

        const mainSrcDoc = getIframe().getAttribute("srcdoc") ?? "";
        expect(mainSrcDoc).toContain("This is my reply text.");
        expect(mainSrcDoc).not.toContain("Original quoted text");

        fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.showQuotedContent") }));

        await waitFor(() => {
          expect(screen.getAllByTitle(i18n.t("mail.emailContent"))).toHaveLength(2);
        });
        const srcDocs = screen
          .getAllByTitle(i18n.t("mail.emailContent"))
          .map((el) => el.getAttribute("srcdoc") ?? "");
        expect(srcDocs.some((doc) => doc.includes("Original quoted text"))).toBe(true);
      });

      it("renders an all-quote body normally instead of an empty iframe behind a toggle that hides everything", () => {
        const allQuoteBody = '<blockquote class="gmail_quote">Entirely quoted content, no new text at all.</blockquote>';

        render(<EmailBody bodyHtml={allQuoteBody} bodyText={null} />);

        expect(screen.getAllByTitle(i18n.t("mail.emailContent"))).toHaveLength(1);
        const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
        expect(srcDoc).toContain("Entirely quoted content, no new text at all.");
        expect(screen.queryByRole("button", { name: i18n.t("mail.showQuotedContent") })).not.toBeInTheDocument();
      });

      it("does not truncate plain text at a lone '>' line that isn't actually a trailing quote", () => {
        // "> a quoted-looking line" here is a red herring (a code snippet, a
        // shell prompt, a numeric comparison) — real new content follows it,
        // so it must not be treated as a quote boundary.
        const body = "New content here.\n> a quoted-looking line\nMore new content after.";

        render(<EmailBody bodyHtml={null} bodyText={body} />);

        expect(screen.getByText(/New content here\./)).toBeInTheDocument();
        expect(screen.getByText(/a quoted-looking line/)).toBeInTheDocument();
        expect(screen.getByText(/More new content after\./)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: i18n.t("mail.showQuotedContent") })).not.toBeInTheDocument();
      });
    });

    // Security regression lock: the split that decides where the quote
    // starts happens on RAW html in a detached document (never executed),
    // but the quoted trail itself must still go through sanitizeEmailHtml
    // and the same sandbox="" iframe as the main body once revealed — a
    // dangerous payload hidden inside the quote must be neutralized exactly
    // like it already is in the main body.
    it("sanitizes the quoted trail before rendering it — a dangerous payload inside the quote is neutralized once revealed", async () => {
      const dangerousBody =
        '<p style="margin:0">New content</p>' +
        '<blockquote class="gmail_quote">' +
        "<script>window.__pwned = true;</script>" +
        '<img src="https://evil.test/track.png">' +
        '<div style="background:url(https://evil.test/bg.png)">quoted payload marker</div>' +
        "</blockquote>";

      render(<EmailBody bodyHtml={dangerousBody} bodyText={null} />);

      fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.showQuotedContent") }));

      await waitFor(() => {
        expect(screen.getAllByTitle(i18n.t("mail.emailContent"))).toHaveLength(2);
      });
      const srcDocs = screen
        .getAllByTitle(i18n.t("mail.emailContent"))
        .map((el) => el.getAttribute("srcdoc") ?? "");
      const quotedSrcDoc = srcDocs.find((doc) => doc.includes("quoted payload marker"));
      expect(quotedSrcDoc).toBeTruthy();

      expect(quotedSrcDoc).not.toContain("<script");
      expect(quotedSrcDoc).not.toContain("window.__pwned");
      // Matches sanitize.test.ts's own convention: a blocked remote <img>'s
      // URL is kept percent-encoded (recoverable for a future "load
      // images" opt-in — see sanitizeEmailHtml's data-blocked-src comment),
      // so it's the live, fetchable "https://evil.test" URL that must never
      // appear, not every character of the domain name.
      expect(quotedSrcDoc).not.toContain("https://evil.test");
      // The live `src` was neutralized (removed), leaving only the inert,
      // percent-encoded data-blocked-src the "load images" toggle can
      // later recover — never a fetchable src attribute.
      expect(quotedSrcDoc).not.toMatch(/<img[^>]*\ssrc="https/);

      // The remote image/CSS url() inside the quote are blocked the same
      // way the main body already blocks them — revealing the quote must
      // not bypass the "load images" gate.
      expect(screen.getByRole("button", { name: i18n.t("mail.loadImages") })).toBeInTheDocument();
    });
  });

  // GH #135: Gmail-style clipping for very long HTML messages (typically
  // marketing/newsletter mail) — clipped with a "View entire message"
  // control, expanding through the same sanitized, sandboxed iframe path.
  describe("message truncation (GH #135)", () => {
    // Comfortably over BODY_TRUNCATE_TEXT_THRESHOLD (1000 chars of visible
    // text) on plain <p> markup alone — proves the trigger is real reading
    // content, not markup bulk (a table-heavy fixture is covered by the
    // "quoted trail" tests' reuse of long content too).
    function longHtmlBody(paragraphCount = 10): string {
      const sentence =
        "This is a sufficiently long paragraph of newsletter-style marketing copy to push the visible text length well past the truncation threshold.";
      return Array.from({ length: paragraphCount }, (_, i) => `<p style="margin:0 0 8px">${sentence} Paragraph ${i + 1}.</p>`).join(
        "",
      );
    }

    const CLIPPED_HEIGHT = "min(35vh, 260px)";

    it("renders a short message fully with no truncation control", () => {
      render(<EmailBody bodyHtml={HTML_BODY} bodyText={null} />);

      expect(screen.queryByRole("button", { name: i18n.t("mail.showFullMessage") })).not.toBeInTheDocument();
      const srcDoc = getIframe().getAttribute("srcdoc") ?? "";
      expect(srcDoc).toContain("Hello");
    });

    it("clips an over-long message and shows the reveal control", () => {
      render(<EmailBody bodyHtml={longHtmlBody()} bodyText={null} />);

      const button = screen.getByRole("button", { name: i18n.t("mail.showFullMessage") });
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute("aria-expanded", "false");

      // Still the SAME sandboxed iframe/srcDoc carrying the FULL sanitized
      // content — only the visible height is clipped, never a smaller HTML
      // subset.
      const iframe = getIframe();
      const srcDoc = iframe.getAttribute("srcdoc") ?? "";
      expect(srcDoc).toContain("Paragraph 10");
      expect(iframe.style.height).toBe(CLIPPED_HEIGHT);
      // No internal scrollbar sneak-peek at the rest while clipped.
      expect(iframe.getAttribute("scrolling")).toBe("no");
    });

    it("reveals the full content in the same iframe when the control is activated", () => {
      render(<EmailBody bodyHtml={longHtmlBody()} bodyText={null} />);

      const beforeSrcDoc = getIframe().getAttribute("srcdoc") ?? "";
      fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.showFullMessage") }));

      // Gmail-style one-way reveal: the control itself is gone once expanded.
      expect(screen.queryByRole("button", { name: i18n.t("mail.showFullMessage") })).not.toBeInTheDocument();

      const iframe = getIframe();
      expect(iframe.style.height).not.toBe(CLIPPED_HEIGHT);
      expect(iframe.getAttribute("scrolling")).not.toBe("no");
      // Exactly the same sanitized document as before — expanding only ever
      // changes the iframe's presentation, never swaps in different markup.
      expect(iframe.getAttribute("srcdoc")).toBe(beforeSrcDoc);
    });

    it("keeps stripping dangerous content in both the clipped and expanded states — no second, unsanitized render path", () => {
      const dangerousLongBody = `${longHtmlBody()}<script>window.__pwned = true;</script>`;
      render(<EmailBody bodyHtml={dangerousLongBody} bodyText={null} />);

      const beforeSrcDoc = getIframe().getAttribute("srcdoc") ?? "";
      expect(beforeSrcDoc).not.toContain("<script");
      expect(beforeSrcDoc).not.toContain("__pwned");

      fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.showFullMessage") }));

      const afterSrcDoc = getIframe().getAttribute("srcdoc") ?? "";
      expect(afterSrcDoc).not.toContain("<script");
      expect(afterSrcDoc).not.toContain("__pwned");
    });

    it("is a real, keyboard-reachable button with an accessible name", () => {
      render(<EmailBody bodyHtml={longHtmlBody()} bodyText={null} />);

      const button = screen.getByRole("button", { name: i18n.t("mail.showFullMessage") });
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
      expect(button).not.toHaveAttribute("tabindex", "-1");
      expect(button).not.toBeDisabled();
    });

    it("does not truncate the plain-text (<pre>) path — truncation targets HTML marketing mail specifically", () => {
      const longText = "Line of plain text content. ".repeat(100);
      render(<EmailBody bodyHtml={null} bodyText={longText} />);

      expect(screen.queryByRole("button", { name: i18n.t("mail.showFullMessage") })).not.toBeInTheDocument();
    });

    // Interaction with the existing quoted-trail collapse (GH #91): two
    // overlapping collapse mechanisms on the same content would be
    // confusing, so truncation only ever measures/clips the NEW-content
    // half of the split — the quoted trail keeps its single existing
    // show/hide toggle and is never itself truncated, however long it is.
    describe("interaction with the quoted-trail collapse (GH #91)", () => {
      it("never shows a truncation control for the quoted trail, even once revealed", () => {
        const longQuotedBody =
          '<p style="margin:0">Short new reply.</p>' + `<blockquote class="gmail_quote">${longHtmlBody()}</blockquote>`;
        render(<EmailBody bodyHtml={longQuotedBody} bodyText={null} />);

        // The new content is short — no truncation control for the main body.
        expect(screen.queryByRole("button", { name: i18n.t("mail.showFullMessage") })).not.toBeInTheDocument();

        // Revealing the (long) quoted trail must not introduce a second
        // truncation control for it either.
        fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.showQuotedContent") }));
        expect(screen.queryByRole("button", { name: i18n.t("mail.showFullMessage") })).not.toBeInTheDocument();
      });

      it("keeps the truncation control and the quote-reveal toggle independent when both the new content and the quote are long", async () => {
        const body = `${longHtmlBody()}<blockquote class="gmail_quote">${longHtmlBody()}</blockquote>`;
        render(<EmailBody bodyHtml={body} bodyText={null} />);

        expect(screen.getByRole("button", { name: i18n.t("mail.showFullMessage") })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: i18n.t("mail.showQuotedContent") })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.showQuotedContent") }));

        await waitFor(() => {
          expect(screen.getAllByTitle(i18n.t("mail.emailContent"))).toHaveLength(2);
        });
        // Still exactly one truncation control total — for the new-content
        // iframe only, never duplicated onto the now-visible quoted iframe.
        expect(screen.getAllByRole("button", { name: i18n.t("mail.showFullMessage") })).toHaveLength(1);
      });
    });
  });
});
