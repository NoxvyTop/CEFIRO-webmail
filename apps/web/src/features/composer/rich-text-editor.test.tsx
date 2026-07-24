import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { sanitizeEmailHtml } from "../reader/sanitize";
import { isSafeLinkUrl, RichTextEditor } from "./RichTextEditor";

function pngFile(name: string, byteLength: number, type = "image/png"): File {
  return new File([new Uint8Array(byteLength)], name, { type });
}

// A controllable stand-in for the browser FileReader, used to deterministically
// drive (and defer) the load/error callbacks that readFileAsDataUrl relies on,
// instead of racing the real async file-read machinery.
class ManualFileReader {
  static instances: ManualFileReader[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: Error | null = null;
  result: string | null = null;

  readAsDataURL(): void {
    ManualFileReader.instances.push(this);
  }

  succeed(dataUrl: string): void {
    this.result = dataUrl;
    this.onload?.();
  }

  fail(error: Error): void {
    this.error = error;
    this.onerror?.();
  }
}

const RealFileReader = globalThis.FileReader;

function installManualFileReader(): void {
  ManualFileReader.instances = [];
  globalThis.FileReader = ManualFileReader as unknown as typeof FileReader;
}

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

describe("RichTextEditor placeholder", () => {
  it("shows the placeholder when the body is empty", async () => {
    render(<RichTextEditor html="" onChange={() => {}} ariaLabel="Message" />);

    expect(
      await screen.findByText(i18n.t("composer.bodyPlaceholder")),
    ).toBeInTheDocument();
  });

  // TipTap/ProseMirror manages its contentEditable DOM outside of React's
  // event system, so simulating a keystroke via fireEvent.input doesn't
  // reliably flow through its update pipeline in this test environment
  // (see the "updates the body" case in composer.test.tsx for the same
  // caveat). The prop round-trip below is what actually happens in the real
  // Composer: onUpdate calls onChange, the parent re-renders with the new
  // `html`, and that prop change is what this test drives directly.
  it("hides the placeholder once the html prop reflects typed content", () => {
    const { rerender } = render(<RichTextEditor html="" onChange={() => {}} ariaLabel="Message" />);
    expect(screen.getByText(i18n.t("composer.bodyPlaceholder"))).toBeInTheDocument();

    rerender(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    expect(screen.queryByText(i18n.t("composer.bodyPlaceholder"))).not.toBeInTheDocument();
  });

  it("does not show the placeholder when the body already has content", () => {
    render(<RichTextEditor html="<p>Existing draft</p>" onChange={() => {}} ariaLabel="Message" />);

    expect(screen.queryByText(i18n.t("composer.bodyPlaceholder"))).not.toBeInTheDocument();
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

describe("RichTextEditor image insertion", () => {
  function getImageFileInput(): HTMLInputElement {
    return screen.getByLabelText(i18n.t("composer.image")) as HTMLInputElement;
  }

  it("inserts a selected PNG as a data: URL into the editor", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const insertButton = await screen.findByRole("button", { name: i18n.t("composer.insertImage") });
    expect(insertButton).toBeInTheDocument();

    const fileInput = getImageFileInput();
    const file = pngFile("logo.png", 10, "image/png");
    fireEvent.change(fileInput, { target: { files: [file] } });

    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.querySelector("img")).not.toBeNull());
    expect(editor.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });

  it.each([
    ["image/jpeg", "photo.jpg"],
    ["image/gif", "anim.gif"],
    ["image/webp", "pic.webp"],
  ])("accepts %s files", async (type, name) => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const fileInput = getImageFileInput();
    const file = pngFile(name, 10, type);
    fireEvent.change(fileInput, { target: { files: [file] } });

    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.querySelector("img")).not.toBeNull());
    expect(editor.querySelector("img")?.getAttribute("src")).toMatch(new RegExp(`^data:${type.replace("/", "\\/")};base64,`));
  });

  it("rejects a file over the size cap and shows an i18n error without inserting", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const fileInput = getImageFileInput();
    const oversized = pngFile("huge.png", 2_000_000, "image/png");
    fireEvent.change(fileInput, { target: { files: [oversized] } });

    expect(await screen.findByText(i18n.t("composer.imageTooLarge"))).toBeInTheDocument();

    const editor = screen.getByRole("textbox", { name: "Message" });
    expect(editor.querySelector("img")).toBeNull();
  });

  it("rejects an unsupported file type and shows an i18n error without inserting", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const fileInput = getImageFileInput();
    const svg = pngFile("evil.svg", 10, "image/svg+xml");
    fireEvent.change(fileInput, { target: { files: [svg] } });

    expect(await screen.findByText(i18n.t("composer.imageInvalidType"))).toBeInTheDocument();

    const editor = screen.getByRole("textbox", { name: "Message" });
    expect(editor.querySelector("img")).toBeNull();
  });

  it("clears a previous error once a valid image is inserted afterward", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const fileInput = getImageFileInput();
    fireEvent.change(fileInput, { target: { files: [pngFile("huge.png", 2_000_000, "image/png")] } });
    expect(await screen.findByText(i18n.t("composer.imageTooLarge"))).toBeInTheDocument();

    fireEvent.change(fileInput, { target: { files: [pngFile("ok.png", 10, "image/png")] } });

    await waitFor(() =>
      expect(screen.queryByText(i18n.t("composer.imageTooLarge"))).not.toBeInTheDocument(),
    );
    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.querySelector("img")).not.toBeNull());
  });

  it("keeps an inserted image intact after a content re-sync (e.g. switching signatures re-feeds bodyHtml)", async () => {
    const { rerender } = render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const fileInput = getImageFileInput();
    fireEvent.change(fileInput, { target: { files: [pngFile("logo.png", 10, "image/png")] } });

    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.querySelector("img")).not.toBeNull());
    const htmlWithImage = editor.innerHTML;
    expect(htmlWithImage).toContain("data:image/png;base64,");

    // Simulate a real setContent re-sync: the parent re-feeds a *different*
    // html string that still carries the same inserted image — exactly what
    // happens when applySignature() rewraps bodyHtml around a signature
    // switch and Composer re-renders RichTextEditor with the recomputed
    // value (see composer.test.tsx's signature-switch tests). A different
    // string forces RichTextEditor's `html !== editor.getHTML()` effect to
    // call editor.commands.setContent(html, false), which re-parses the
    // whole doc through the schema — exactly where an Image extension
    // without allowBase64 (default false, parse rule
    // `img[src]:not([src^="data:"])`) silently drops the data: image.
    rerender(
      <RichTextEditor
        html={`<div data-cefiro-signature="true">${htmlWithImage}</div>`}
        onChange={() => {}}
        ariaLabel="Message"
      />,
    );

    await waitFor(() => {
      const img = editor.querySelector("img");
      expect(img).not.toBeNull();
      expect(img?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    });
  });

  describe("file read failure handling", () => {
    afterEach(() => {
      globalThis.FileReader = RealFileReader;
    });

    it("shows a generic i18n error and does not insert when the file read fails", async () => {
      installManualFileReader();
      render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

      const fileInput = getImageFileInput();
      fireEvent.change(fileInput, { target: { files: [pngFile("logo.png", 10, "image/png")] } });

      await waitFor(() => expect(ManualFileReader.instances).toHaveLength(1));
      ManualFileReader.instances[0]?.fail(new Error("read failed"));

      expect(await screen.findByText(i18n.t("composer.errors.generic"))).toBeInTheDocument();

      const editor = screen.getByRole("textbox", { name: "Message" });
      expect(editor.querySelector("img")).toBeNull();
    });

    // No dedicated test for "editor destroyed mid-read": verified directly
    // against @tiptap/core (2.27.2) that calling chain().focus().setImage()
    // .run() on an already-destroyed Editor does not throw — isDestroyed
    // becomes true once EditorView.destroy() clears its internal docView,
    // and dispatching a transaction against a torn-down view is a no-op at
    // the DOM-sync level rather than an exception. A test asserting "does
    // not throw" here would pass identically with or without the guard
    // below, which fails the "watch it fail for the real reason" bar for a
    // meaningful regression test (see the test-driven-development skill's
    // "tests that pass immediately prove nothing" guidance). The
    // `editor.isDestroyed` re-check is still added as defensive, technically
    // correct code — it mirrors TipTap's own internal convention (`if
    // (!editor.isDestroyed)`) and avoids running a command against — and
    // setting React state from — a component instance mid-teardown.
  });
});

describe("RichTextEditor text alignment toolbar", () => {
  it("renders left/center/right text align buttons with accessible labels", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    expect(
      await screen.findByRole("button", { name: i18n.t("composer.textAlignLeft") }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("composer.textAlignCenter") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("composer.textAlignRight") })).toBeInTheDocument();
  });

  it("applies text-align: center to the current paragraph when the center button is clicked", async () => {
    const handleChange = vi.fn();
    render(<RichTextEditor html="<p>Hello</p>" onChange={handleChange} ariaLabel="Message" />);

    const centerButton = await screen.findByRole("button", { name: i18n.t("composer.textAlignCenter") });
    fireEvent.click(centerButton);

    await waitFor(() => {
      const lastCall = handleChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toContain("text-align: center");
    });
  });

  it("applies text-align: right to the current paragraph when the right button is clicked", async () => {
    const handleChange = vi.fn();
    render(<RichTextEditor html="<p>Hello</p>" onChange={handleChange} ariaLabel="Message" />);

    const rightButton = await screen.findByRole("button", { name: i18n.t("composer.textAlignRight") });
    fireEvent.click(rightButton);

    await waitFor(() => {
      const lastCall = handleChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toContain("text-align: right");
    });
  });

  it("marks the clicked alignment button as pressed via aria-pressed, and others as not pressed", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const leftButton = await screen.findByRole("button", { name: i18n.t("composer.textAlignLeft") });
    const centerButton = screen.getByRole("button", { name: i18n.t("composer.textAlignCenter") });

    expect(centerButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(centerButton);

    await waitFor(() => expect(centerButton).toHaveAttribute("aria-pressed", "true"));
    expect(leftButton).toHaveAttribute("aria-pressed", "false");
  });
});

describe("RichTextEditor image size/alignment toolbar", () => {
  it("renders size and alignment buttons with accessible labels", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    expect(
      await screen.findByRole("button", { name: i18n.t("composer.imageSizeSmall") }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageSizeMedium") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageSizeLarge") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageAlignLeft") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageAlignCenter") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageAlignRight") })).toBeInTheDocument();
  });

  it("disables size/alignment buttons when no image is selected, even if an image exists in the doc", async () => {
    // No trailing ` />` self-close: must match TipTap's own getHTML()
    // serialization for a void element (`<img ...>`) exactly. RichTextEditor's
    // html-prop-resync effect (`if (html !== editor.getHTML())`) does a plain
    // string comparison — a formatting-only mismatch (e.g. the self-closing
    // slash) makes it re-run setContent() right after mount, which replaces
    // the whole doc and forces ProseMirror to re-resolve the selection. For a
    // doc ending in an atom node (no trailing paragraph to place a cursor
    // in), that re-resolution can itself land on a NodeSelection of the
    // image — a real, separately-noteworthy quirk, but not what this test is
    // about, so it's avoided here by keeping the initial html byte-for-byte
    // stable across the mount round-trip.
    render(
      <RichTextEditor
        html='<p>Hello</p><img src="data:image/png;base64,AAAA">'
        onChange={() => {}}
        ariaLabel="Message"
      />,
    );

    expect(await screen.findByRole("button", { name: i18n.t("composer.imageSizeSmall") })).toBeDisabled();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageSizeMedium") })).toBeDisabled();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageSizeLarge") })).toBeDisabled();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageAlignLeft") })).toBeDisabled();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageAlignCenter") })).toBeDisabled();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageAlignRight") })).toBeDisabled();
  });

  it("disables size/alignment buttons when the document has no image at all", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    expect(await screen.findByRole("button", { name: i18n.t("composer.imageSizeMedium") })).toBeDisabled();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageAlignCenter") })).toBeDisabled();
  });

  // ProseMirror resolves the initial `Selection.atStart(doc)` to a
  // NodeSelection when the very first node in the document is a leaf/atom
  // node (an image can't hold a text cursor) — confirmed by inspecting the
  // rendered DOM (`class="ProseMirror-selectednode"` appears on the <img>
  // with no click simulated at all). That gives a real, click-free way to
  // exercise the full "image is selected -> toolbar enables -> clicking
  // applies the attribute" path in jsdom, sidestepping the coordinate-based
  // hit-testing that fireEvent.click on a specific node cannot reliably
  // drive here (see the placeholder describe block above for the same
  // jsdom/ProseMirror caveat on typing simulation).
  it("enables size/align controls for an image that is the sole (and thus auto-selected) doc content, and applies clicks to it", async () => {
    const handleChange = vi.fn();
    render(
      <RichTextEditor
        html='<img src="data:image/png;base64,AAAA" />'
        onChange={handleChange}
        ariaLabel="Message"
      />,
    );

    const mediumButton = await screen.findByRole("button", { name: i18n.t("composer.imageSizeMedium") });
    expect(mediumButton).not.toBeDisabled();

    fireEvent.click(mediumButton);

    await waitFor(() => {
      const lastCall = handleChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toContain("width: 50%");
    });

    const centerButton = screen.getByRole("button", { name: i18n.t("composer.imageAlignCenter") });
    fireEvent.click(centerButton);

    await waitFor(() => {
      const lastCall = handleChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toContain("margin-left: auto");
    });
  });
});
