import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMeta } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AttachmentViewer } from "./AttachmentViewer";

// Real PDF/image rendering, iframe navigation, and window/iframe printing
// are browser behavior jsdom can't reproduce — see the module docstring on
// AttachmentViewer.tsx for the full reasoning. These tests pin the
// *contract* the fix relies on instead:
//  1. the viewer fetches the attachment's bytes itself, credentialed,
//     against the blob endpoint (never navigates an <img>/<iframe> straight
//     to it — that's exactly the direct-URL approach that breaks under the
//     endpoint's tokenless CSP sandbox in a real browser: opaque origin ->
//     contentWindow.print() throws, and Chrome's native PDF viewer can't
//     run the script it needs),
//  2. those bytes become a same-origin `blob:` object URL, used as the
//     <img>/<iframe> src,
//  3. that object URL is revoked on close and on switching to a different
//     attachment (no leaks), and
//  4. Imprimir stays disabled until the relevant iframe's `load` fires, so
//     it can never print a still-loading document.
// Actual PDF render fidelity and the print dialog itself need a real-browser
// check (see the implementation report).

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function makeAttachment(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    blobId: "b1",
    name: "file.pdf",
    type: "application/pdf",
    size: 2048,
    cid: null,
    ...overrides,
  };
}

let objectUrlCounter: number;
let createObjectUrlMock: ReturnType<typeof vi.fn>;
let revokeObjectUrlMock: ReturnType<typeof vi.fn>;

// jsdom doesn't implement URL.createObjectURL/revokeObjectURL at all (not
// even a "not implemented" stub — the properties are simply undefined), so
// they're patched on directly for these tests rather than via vi.spyOn
// (which requires the property to already exist).
beforeEach(() => {
  objectUrlCounter = 0;
  createObjectUrlMock = vi.fn((_obj: Blob | MediaSource) => `blob:mock-${++objectUrlCounter}`);
  revokeObjectUrlMock = vi.fn((_url: string) => {});
  URL.createObjectURL = createObjectUrlMock as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectUrlMock as typeof URL.revokeObjectURL;

  // A safe default so tests that don't care about fetch/preview timing
  // (dialog chrome, focus, Esc, scrim) don't hang on a real network call.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF_BYTES, { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Deliberately NOT deleting URL.createObjectURL/revokeObjectURL here:
  // React Testing Library's own autocleanup (registered as an earlier
  // afterEach, so it runs after this one — afterEach hooks run in reverse
  // registration order) unmounts components after this hook, which fires
  // AttachmentViewer's effect cleanup and calls URL.revokeObjectURL. Each
  // test's beforeEach reassigns fresh mocks anyway, so leaving the patched
  // methods in place between tests is harmless.
});

// jsdom's <iframe> never actually navigates to a blob: URL (or any URL), so
// `load` never fires on its own — tests fire it manually once the iframe
// exists, to simulate the browser finishing loading the document.
function stubContentWindow(iframe: HTMLIFrameElement) {
  const print = vi.fn();
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    value: { print },
  });
  return print;
}

function ToggleHarness({ attachment, kind }: { attachment: AttachmentMeta; kind: "image" | "pdf" }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open viewer
      </button>
      <AttachmentViewer attachment={open ? attachment : null} kind={kind} onClose={() => setOpen(false)} />
    </div>
  );
}

describe("AttachmentViewer", () => {
  it("renders nothing when attachment is null (and never fetches)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<AttachmentViewer attachment={null} kind="image" onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders a dialog labelled by the attachment name when open", () => {
    render(
      <AttachmentViewer attachment={makeAttachment({ name: "report.pdf" })} kind="pdf" onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "report.pdf");
  });

  it("shows a loading state while the blob fetch is in flight", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<AttachmentViewer attachment={makeAttachment()} kind="pdf" onClose={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent(i18n.t("attachments.previewLoading"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("shows an error state if the blob fetch fails, but Descargar keeps working", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    render(
      <AttachmentViewer
        attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })}
        kind="pdf"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(i18n.t("attachments.previewError")));

    const link = screen.getByRole("link", { name: i18n.t("attachments.download") });
    expect(link).toHaveAttribute(
      "href",
      "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf&dl=1",
    );
  });

  describe("image attachment", () => {
    it("fetches the blob credentialed and renders it as a same-origin object-URL <img>", async () => {
      const fetchMock = vi.fn(async () => new Response(PDF_BYTES, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      render(
        <AttachmentViewer
          attachment={makeAttachment({ name: "photo.png", type: "image/png" })}
          kind="image"
          onClose={vi.fn()}
        />,
      );

      const img = await screen.findByRole("img", { name: "photo.png" });
      expect(img.getAttribute("src")).toMatch(/^blob:mock-/);

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/mail/blobs/b1?name=photo.png&type=image%2Fpng",
        expect.objectContaining({ credentials: "include" }),
      );
      expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
      const blobArg = createObjectUrlMock.mock.calls[0]![0] as Blob;
      expect(blobArg.type).toBe("image/png");
    });

    it("mounts a hidden print-only iframe pointed at the same object URL", async () => {
      render(
        <AttachmentViewer
          attachment={makeAttachment({ name: "photo.png", type: "image/png" })}
          kind="image"
          onClose={vi.fn()}
        />,
      );

      const img = await screen.findByRole("img", { name: "photo.png" });
      const printFrame = document.querySelector("iframe[data-print-frame]") as HTMLIFrameElement;
      expect(printFrame).toBeTruthy();
      expect(printFrame.getAttribute("src")).toBe(img.getAttribute("src"));
    });

    it("Imprimir is disabled until the print iframe loads, then prints via its contentWindow", async () => {
      render(
        <AttachmentViewer
          attachment={makeAttachment({ name: "photo.png", type: "image/png" })}
          kind="image"
          onClose={vi.fn()}
        />,
      );

      await screen.findByRole("img", { name: "photo.png" });
      const printFrame = document.querySelector("iframe[data-print-frame]") as HTMLIFrameElement;
      const print = stubContentWindow(printFrame);
      const printButton = screen.getByRole("button", { name: i18n.t("attachments.print") });

      expect(printButton).toBeDisabled();
      fireEvent.click(printButton);
      expect(print).not.toHaveBeenCalled();

      fireEvent.load(printFrame);
      expect(printButton).not.toBeDisabled();

      fireEvent.click(printButton);
      expect(print).toHaveBeenCalledTimes(1);
    });
  });

  describe("pdf attachment", () => {
    it("fetches the blob credentialed and renders it as a same-origin object-URL <iframe>", async () => {
      const fetchMock = vi.fn(async () => new Response(PDF_BYTES, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      render(
        <AttachmentViewer
          attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })}
          kind="pdf"
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => expect(document.querySelector("iframe")).toBeTruthy());
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;
      expect(iframe.getAttribute("src")).toMatch(/^blob:mock-/);
      expect(screen.queryByRole("img")).not.toBeInTheDocument();

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf",
        expect.objectContaining({ credentials: "include" }),
      );
    });

    it("Imprimir is disabled until the visible iframe loads, then prints via its contentWindow", async () => {
      render(
        <AttachmentViewer
          attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })}
          kind="pdf"
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => expect(document.querySelector("iframe")).toBeTruthy());
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;
      const print = stubContentWindow(iframe);
      const printButton = screen.getByRole("button", { name: i18n.t("attachments.print") });

      expect(printButton).toBeDisabled();
      fireEvent.click(printButton);
      expect(print).not.toHaveBeenCalled();

      fireEvent.load(iframe);
      expect(printButton).not.toBeDisabled();

      fireEvent.click(printButton);
      expect(print).toHaveBeenCalledTimes(1);
    });

    it("does not crash if contentWindow.print() itself throws", async () => {
      render(
        <AttachmentViewer
          attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })}
          kind="pdf"
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => expect(document.querySelector("iframe")).toBeTruthy());
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;
      Object.defineProperty(iframe, "contentWindow", {
        configurable: true,
        value: {
          print: () => {
            throw new DOMException("blocked", "SecurityError");
          },
        },
      });
      fireEvent.load(iframe);

      expect(() =>
        fireEvent.click(screen.getByRole("button", { name: i18n.t("attachments.print") })),
      ).not.toThrow();
    });
  });

  it("revokes the object URL when the viewer closes", async () => {
    render(<ToggleHarness attachment={makeAttachment()} kind="pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "open viewer" }));

    await waitFor(() => expect(createObjectUrlMock).toHaveBeenCalledTimes(1));
    const createdUrl = createObjectUrlMock.mock.results[0]!.value as string;

    fireEvent.keyDown(window, { key: "Escape" });
    expect(revokeObjectUrlMock).toHaveBeenCalledWith(createdUrl);
  });

  it("revokes the previous object URL and re-fetches when switching to a different attachment", async () => {
    const fetchMock = vi.fn(async () => new Response(PDF_BYTES, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();

    const { rerender } = render(
      <AttachmentViewer attachment={makeAttachment({ blobId: "first" })} kind="pdf" onClose={onClose} />,
    );
    await waitFor(() => expect(createObjectUrlMock).toHaveBeenCalledTimes(1));
    const firstUrl = createObjectUrlMock.mock.results[0]!.value as string;

    rerender(
      <AttachmentViewer attachment={makeAttachment({ blobId: "second" })} kind="pdf" onClose={onClose} />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(revokeObjectUrlMock).toHaveBeenCalledWith(firstUrl);
    await waitFor(() => expect(createObjectUrlMock).toHaveBeenCalledTimes(2));
  });

  it("Descargar links to the real dl=1 blob endpoint url (never an object URL)", () => {
    render(
      <AttachmentViewer
        attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })}
        kind="pdf"
        onClose={vi.fn()}
      />,
    );

    const link = screen.getByRole("link", { name: i18n.t("attachments.download") });
    expect(link).toHaveAttribute(
      "href",
      "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf&dl=1",
    );
  });

  it("calls onClose when the close (✕) button is clicked", () => {
    const onClose = vi.fn();
    render(<AttachmentViewer attachment={makeAttachment()} kind="pdf" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: i18n.t("attachments.close") }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<AttachmentViewer attachment={makeAttachment()} kind="pdf" onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicking the scrim", () => {
    const onClose = vi.fn();
    render(<AttachmentViewer attachment={makeAttachment()} kind="pdf" onClose={onClose} />);

    fireEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the dialog", () => {
    const onClose = vi.fn();
    render(<AttachmentViewer attachment={makeAttachment()} kind="pdf" onClose={onClose} />);

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus into the dialog when it opens and restores it to the opener when it closes", async () => {
    render(<ToggleHarness attachment={makeAttachment()} kind="pdf" />);
    const trigger = screen.getByRole("button", { name: "open viewer" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("traps Tab focus within the dialog (wraps from last control back to first), including the enabled Imprimir button once loaded", async () => {
    render(<AttachmentViewer attachment={makeAttachment()} kind="pdf" onClose={vi.fn()} />);

    await waitFor(() => expect(document.querySelector("iframe")).toBeTruthy());
    fireEvent.load(document.querySelector("iframe") as HTMLIFrameElement);

    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    expect(focusable.length).toBe(3); // Descargar, Imprimir (now enabled), Cerrar
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;

    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
