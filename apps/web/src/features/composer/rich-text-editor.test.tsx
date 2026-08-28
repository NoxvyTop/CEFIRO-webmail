import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { IMAGE_SIZE_PRESETS } from "./resizableImageExtension";
import {
  ContentEditableFallback,
  htmlToPlainText,
  isSafeLinkUrl,
  RichTextEditor,
} from "./RichTextEditor";

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

// GH #213: the fallback renders in the app's own document, with none of the
// `sandbox=""` isolation the reader gives email HTML (reader/EmailBody.tsx).
// These pin that it therefore renders NO markup at all — not "sanitized
// markup", which is what it used to do and what the issue is about: DOMPurify
// keeps <style>, and sanitize's parse/serialize/re-parse round trip ran here
// with the app's full privileges.
const HOSTILE_QUOTE = [
  "<style>body{background:url(https://tracker.test/p.png)}</style>",
  "<p>Hola <b>equipo</b></p>",
  '<img src="https://tracker.test/pixel.png" alt="pixel">',
  '<video poster="https://tracker.test/poster.png"></video>',
  '<a href="https://evil.test/phish">Pulsa aqui</a>',
  '<script>alert("xss")</script>',
].join("");

describe("htmlToPlainText", () => {
  it("keeps the readable text and drops every element", () => {
    const text = htmlToPlainText(HOSTILE_QUOTE);

    expect(text).toContain("Hola equipo");
    expect(text).toContain("Pulsa aqui");
    expect(text).not.toMatch(/[<>]/);
  });

  it("drops the text content of style and script elements", () => {
    const text = htmlToPlainText(HOSTILE_QUOTE);

    expect(text).not.toContain("tracker.test");
    expect(text).not.toContain("alert");
  });

  it("turns block and <br> boundaries into newlines instead of run-on text", () => {
    expect(htmlToPlainText("<p>uno</p><p>dos</p>")).toBe("uno\ndos");
    expect(htmlToPlainText("uno<br>dos")).toBe("uno\ndos");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToPlainText("")).toBe("");
  });
});

describe("RichTextEditor fallback isolation (GH #213)", () => {
  it("renders no element at all inside the unsandboxed textbox", () => {
    render(
      <ContentEditableFallback html={HOSTILE_QUOTE} onChange={() => {}} ariaLabel="Message" />,
    );

    const textbox = screen.getByRole("textbox", { name: "Message" });
    // The strongest form of "never renders unsandboxed HTML": there is no
    // element node in this subtree to render, sanitized or otherwise.
    expect(textbox.querySelectorAll("*")).toHaveLength(0);
    expect(textbox.innerHTML).not.toContain("<");
  });

  it("never emits the hostile URLs into the app document", () => {
    render(
      <ContentEditableFallback html={HOSTILE_QUOTE} onChange={() => {}} ariaLabel="Message" />,
    );

    const textbox = screen.getByRole("textbox", { name: "Message" });
    expect(textbox.innerHTML).not.toContain("tracker.test");
    expect(textbox.innerHTML).not.toContain("evil.test");
  });

  it("still shows the quoted message as readable text", () => {
    render(
      <ContentEditableFallback html={HOSTILE_QUOTE} onChange={() => {}} ariaLabel="Message" />,
    );

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent("Hola equipo");
  });

  it("reports edits back through onChange", () => {
    const onChange = vi.fn();
    render(<ContentEditableFallback html="" onChange={onChange} ariaLabel="Message" />);

    const textbox = screen.getByRole("textbox", { name: "Message" });
    textbox.textContent = "respuesta";
    fireEvent.input(textbox);

    expect(onChange).toHaveBeenCalledWith("respuesta");
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

  // GH #344(c): MAX_IMAGE_BYTES/ALLOWED_IMAGE_TYPES were only enforced in
  // handleImageFileSelected (the toolbar's own file input) above.
  // ResizableImage.configure({ allowBase64: true }) means TipTap's default
  // clipboard/drop handling admits ANY data: image it parses out of pasted
  // HTML, or any image File dropped straight onto the editor, with no size or
  // type check at all — a pasted screenshot could produce a multi-MB draft
  // that then 413s on autosave. handlePaste/handleDrop close that gap using
  // the exact same allowlist/cap, rejecting instead of inserting.
  describe("pasted/dropped image size and type guard (#344c)", () => {
    // No dedicated test drives handleDrop through a real "drop" event: like
    // the mousedown redirect below (see this file's later comment on
    // `document.elementFromPoint` being unimplemented in jsdom),
    // prosemirror-view's own built-in drop handling calls view.posAtCoords
    // BEFORE it ever reaches a custom handleDrop prop, and posAtCoords
    // requires layout/hit-testing jsdom does not provide — so a synthetic
    // drop event cannot reliably reach this code in this test environment.
    // handleDrop shares its two helpers (rejectedImageFileReason,
    // rejectedDataImageReason) with handlePaste, which IS fully exercised
    // below through a path jsdom does support, so the actual rejection logic
    // is covered even though the drop wiring itself is not.
    function base64PayloadForBytes(byteLength: number): string {
      // The guard only estimates decoded length from the base64 string's own
      // length (no atob() call) — see base64DecodedByteLength in
      // RichTextEditor.tsx — so any same-length placeholder string, valid
      // base64 alphabet or not, exercises the same code path.
      return "A".repeat(Math.ceil((byteLength * 4) / 3));
    }

    it("rejects a pasted data: image over the size cap and does not insert it", async () => {
      render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);
      const editor = screen.getByRole("textbox", { name: "Message" });

      const oversizedDataUrl = `data:image/png;base64,${base64PayloadForBytes(2_000_000)}`;
      fireEvent.paste(editor, {
        clipboardData: {
          getData: (format: string) =>
            format === "text/html" ? `<img src="${oversizedDataUrl}">` : "",
          files: [],
        },
      });

      expect(await screen.findByText(i18n.t("composer.imageTooLarge"))).toBeInTheDocument();
      expect(editor.querySelector("img")).toBeNull();
    });

    it("rejects a pasted data: image of a disallowed type and does not insert it", async () => {
      render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);
      const editor = screen.getByRole("textbox", { name: "Message" });

      const svgDataUrl = `data:image/svg+xml;base64,${base64PayloadForBytes(10)}`;
      fireEvent.paste(editor, {
        clipboardData: {
          getData: (format: string) => (format === "text/html" ? `<img src="${svgDataUrl}">` : ""),
          files: [],
        },
      });

      expect(await screen.findByText(i18n.t("composer.imageInvalidType"))).toBeInTheDocument();
      expect(editor.querySelector("img")).toBeNull();
    });

    it("rejects an oversized image file carried directly on the clipboard (no HTML) and does not insert it", async () => {
      render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);
      const editor = screen.getByRole("textbox", { name: "Message" });

      fireEvent.paste(editor, {
        clipboardData: {
          getData: () => "",
          files: [pngFile("screenshot.png", 2_000_000, "image/png")],
        },
      });

      expect(await screen.findByText(i18n.t("composer.imageTooLarge"))).toBeInTheDocument();
      expect(editor.querySelector("img")).toBeNull();
    });

    it("does not block an ordinary text paste", async () => {
      render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);
      const editor = screen.getByRole("textbox", { name: "Message" });

      fireEvent.paste(editor, {
        clipboardData: { getData: () => "", files: [] },
      });

      expect(screen.queryByText(i18n.t("composer.imageTooLarge"))).not.toBeInTheDocument();
      expect(screen.queryByText(i18n.t("composer.imageInvalidType"))).not.toBeInTheDocument();
    });
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

  // #348: these three buttons — and the six image-size/image-align buttons
  // below — used to render a single bare capital letter ("L"/"C"/"R", and
  // "S"/"M"/"L" for image size, ambiguous with image-align's own "L") as
  // their only visible content. Every one of the nine now renders an inline
  // svg icon instead, with the aria-label carrying the accessible name.
  it("renders an svg icon, not a bare letter, in each text-align button", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const leftButton = await screen.findByRole("button", { name: i18n.t("composer.textAlignLeft") });
    const centerButton = screen.getByRole("button", { name: i18n.t("composer.textAlignCenter") });
    const rightButton = screen.getByRole("button", { name: i18n.t("composer.textAlignRight") });

    for (const button of [leftButton, centerButton, rightButton]) {
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button.textContent?.trim()).toBe("");
    }
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

  // #348: see the equivalent text-align test above — image size used bare
  // "S"/"M"/"L" and image align reused the SAME "L"/"C"/"R" letters as text
  // align, ambiguous within one toolbar. All six now render an svg icon.
  it("renders an svg icon, not a bare letter, in each size/align button", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const buttons = [
      await screen.findByRole("button", { name: i18n.t("composer.imageSizeSmall") }),
      screen.getByRole("button", { name: i18n.t("composer.imageSizeMedium") }),
      screen.getByRole("button", { name: i18n.t("composer.imageSizeLarge") }),
      screen.getByRole("button", { name: i18n.t("composer.imageAlignLeft") }),
      screen.getByRole("button", { name: i18n.t("composer.imageAlignCenter") }),
      screen.getByRole("button", { name: i18n.t("composer.imageAlignRight") }),
    ];

    for (const button of buttons) {
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button.textContent?.trim()).toBe("");
    }
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

// Regression coverage for issue #127: the size/align controls appeared to do
// nothing because inserting an image via the toolbar (handleImageFileSelected)
// left the selection *after* the inserted node instead of *on* it as a
// NodeSelection — so `disabled={!isImageSelected}` (and the buttons'
// pointer-events-none) kept the controls inert immediately after the most
// common workflow: insert an image, then try to resize/align it.
//
// jsdom can't simulate a real click landing on a rendered <img> —
// `document.elementFromPoint` is unimplemented, so ProseMirror's
// `posAtCoords` throws — so these tests drive insertion through the real
// handleImageFileSelected path (the file input) rather than clicking an image
// directly, exactly like the "RichTextEditor image insertion" tests above.
describe("RichTextEditor image size/alignment toolbar — selection on insert (issue #127)", () => {
  function getImageFileInput(): HTMLInputElement {
    return screen.getByLabelText(i18n.t("composer.image")) as HTMLInputElement;
  }

  it("enables the size and alignment controls immediately after inserting an image", async () => {
    render(<RichTextEditor html="<p>Hello</p>" onChange={() => {}} ariaLabel="Message" />);

    const fileInput = getImageFileInput();
    fireEvent.change(fileInput, { target: { files: [pngFile("logo.png", 10, "image/png")] } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: i18n.t("composer.imageSizeSmall") })).not.toBeDisabled();
    });
    expect(screen.getByRole("button", { name: i18n.t("composer.imageSizeMedium") })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageSizeLarge") })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageAlignLeft") })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageAlignCenter") })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: i18n.t("composer.imageAlignRight") })).not.toBeDisabled();
  });

  it("applies a size preset to the image that was just inserted", async () => {
    const handleChange = vi.fn();
    render(<RichTextEditor html="<p>Hello</p>" onChange={handleChange} ariaLabel="Message" />);

    const fileInput = getImageFileInput();
    fireEvent.change(fileInput, { target: { files: [pngFile("logo.png", 10, "image/png")] } });

    const smallButton = await screen.findByRole("button", { name: i18n.t("composer.imageSizeSmall") });
    await waitFor(() => expect(smallButton).not.toBeDisabled());
    fireEvent.click(smallButton);

    await waitFor(() => {
      const lastCall = handleChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toContain(`width: ${IMAGE_SIZE_PRESETS.small}`);
    });
  });

  it("applies an alignment to the image that was just inserted", async () => {
    const handleChange = vi.fn();
    render(<RichTextEditor html="<p>Hello</p>" onChange={handleChange} ariaLabel="Message" />);

    const fileInput = getImageFileInput();
    fireEvent.change(fileInput, { target: { files: [pngFile("logo.png", 10, "image/png")] } });

    const rightButton = await screen.findByRole("button", { name: i18n.t("composer.imageAlignRight") });
    await waitFor(() => expect(rightButton).not.toBeDisabled());
    fireEvent.click(rightButton);

    await waitFor(() => {
      const lastCall = handleChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toContain("margin-left: auto");
    });
  });

  it("selects the newly inserted image, not an earlier identical one, when the same image is inserted twice", async () => {
    const handleChange = vi.fn();
    render(<RichTextEditor html="<p>Hello</p>" onChange={handleChange} ariaLabel="Message" />);

    const fileInput = getImageFileInput();
    // Two separate File instances with byte-identical content -> the exact
    // same data: URL, so the two resulting <img> nodes are indistinguishable
    // by src alone.
    fireEvent.change(fileInput, { target: { files: [pngFile("logo.png", 10, "image/png")] } });
    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.querySelectorAll("img")).toHaveLength(1));

    fireEvent.change(fileInput, { target: { files: [pngFile("logo.png", 10, "image/png")] } });
    await waitFor(() => expect(editor.querySelectorAll("img")).toHaveLength(2));

    const largeButton = await screen.findByRole("button", { name: i18n.t("composer.imageSizeLarge") });
    await waitFor(() => expect(largeButton).not.toBeDisabled());
    fireEvent.click(largeButton);

    await waitFor(() => {
      const lastCall = handleChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toContain(`width: ${IMAGE_SIZE_PRESETS.large}`);
    });
    const images = Array.from(editor.querySelectorAll("img"));
    expect(images).toHaveLength(2);
    // The second (just-inserted) image is the one that got resized...
    expect(images[1]?.getAttribute("style") ?? "").toContain(`width: ${IMAGE_SIZE_PRESETS.large}`);
    // ...the first, earlier occurrence of the identical image is untouched.
    expect(images[0]?.getAttribute("style")).toBeNull();
  });

  it("does not modify a different, pre-existing image elsewhere in the document when a control is applied to the newly inserted one", async () => {
    const decoySrc = "data:image/png;base64,ZGVjb3k=";
    render(
      <RichTextEditor
        html={`<p>Hello</p><img src="${decoySrc}"><p>World</p>`}
        onChange={() => {}}
        ariaLabel="Message"
      />,
    );

    const fileInput = getImageFileInput();
    fireEvent.change(fileInput, { target: { files: [pngFile("logo.png", 10, "image/png")] } });

    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.querySelectorAll("img")).toHaveLength(2));

    const centerButton = await screen.findByRole("button", { name: i18n.t("composer.imageAlignCenter") });
    await waitFor(() => expect(centerButton).not.toBeDisabled());
    fireEvent.click(centerButton);

    await waitFor(() => {
      const decoyImg = editor.querySelector(`img[src="${decoySrc}"]`);
      expect(decoyImg).not.toBeNull();
      expect(decoyImg?.getAttribute("style")).toBeNull();
    });
  });

  it("never leaks the editor-only selection class into getHTML() output", async () => {
    const handleChange = vi.fn();
    render(<RichTextEditor html="<p>Hello</p>" onChange={handleChange} ariaLabel="Message" />);

    const fileInput = getImageFileInput();
    fireEvent.change(fileInput, { target: { files: [pngFile("logo.png", 10, "image/png")] } });

    const editor = screen.getByRole("textbox", { name: "Message" });
    // Sanity check the fix actually selected the node: the class IS present
    // in the live editor DOM...
    await waitFor(() => {
      expect(editor.querySelector("img")).toHaveClass("ProseMirror-selectednode");
    });

    // ...but that live-view-only class must never appear in the serialized
    // getHTML() output that becomes the stored/sent email body.
    expect(handleChange.mock.calls.length).toBeGreaterThan(0);
    for (const call of handleChange.mock.calls) {
      expect(call[0]).not.toContain("ProseMirror-selectednode");
    }
  });
});
