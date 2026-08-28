import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMeta } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AttachmentCard, attachmentThumbnailKind, formatSizeKb } from "./AttachmentCard";

// Controllable IntersectionObserver double — same pattern as
// useInViewport.test.tsx's own FakeIntersectionObserver. jsdom has no
// IntersectionObserver at all, so every OTHER test in this file already
// exercises useInViewport's "unavailable -> visible immediately" fallback;
// only the tests below need this to actually withhold visibility.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve() {}
  disconnect() {}

  intersect(target: Element, isIntersecting: boolean) {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

// PdfThumbnail itself does real pdf.js work (covered separately, with its
// own dynamic-import mocking, in pdf-thumbnail.test.tsx) — here we only care
// that AttachmentCard *chooses* PdfThumbnail for pdf attachments, and *what
// it passes as the loading vs. error fallback* (GH #94: a compact branded
// Céfiro loader while loading, the plain file icon on permanent failure —
// two distinct props/states, so a failed PDF never spins forever), so it's
// swapped for a cheap marker that renders both fallbacks into their own
// slots for the tests to inspect independently.
vi.mock("./PdfThumbnail", () => ({
  PdfThumbnail: ({
    blobId,
    fallback,
    loadingFallback,
  }: {
    blobId: string;
    fallback: ReactNode;
    loadingFallback?: ReactNode;
  }) => (
    <div data-testid="pdf-thumbnail" data-blob-id={blobId}>
      <div data-testid="pdf-thumbnail-loading-fallback">{loadingFallback}</div>
      <div data-testid="pdf-thumbnail-error-fallback">{fallback}</div>
    </div>
  ),
}));

// AttachmentViewer itself (the in-app preview overlay) is covered in its own
// attachment-viewer.test.tsx — here we only care that AttachmentCard *wires*
// the thumbnail/"Ver" control to open it for the right attachment, so it's
// swapped for a cheap marker that surfaces what it was opened with.
vi.mock("./AttachmentViewer", () => ({
  AttachmentViewer: ({
    attachment,
    onClose,
  }: {
    attachment: AttachmentMeta | null;
    onClose: () => void;
  }) =>
    attachment ? (
      <div data-testid="attachment-viewer" data-blob-id={attachment.blobId}>
        <button type="button" onClick={onClose}>
          mock-close
        </button>
      </div>
    ) : null,
}));

function makeAttachment(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    blobId: "b1",
    name: "file.bin",
    type: "application/octet-stream",
    size: 2048,
    cid: null,
    ...overrides,
  };
}

describe("attachmentThumbnailKind", () => {
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "classifies %s as an image thumbnail",
    (type) => {
      expect(attachmentThumbnailKind(type)).toBe("image");
    },
  );

  it("classifies application/pdf as a pdf thumbnail", () => {
    expect(attachmentThumbnailKind("application/pdf")).toBe("pdf");
  });

  it.each([
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/csv",
    "application/zip",
    "text/plain",
  ])("classifies %s as a generic icon card (no in-browser preview)", (type) => {
    expect(attachmentThumbnailKind(type)).toBe("icon");
  });

  it("ignores a trailing charset parameter when classifying", () => {
    expect(attachmentThumbnailKind("image/png; charset=binary")).toBe("image");
  });
});

describe("AttachmentCard", () => {
  it("renders a real <img> thumbnail for an image attachment, inline (no dl=1)", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "photo.png", type: "image/png" })} />);

    const img = screen.getByRole("img", { name: "photo.png" });
    expect(img).toHaveAttribute("src", "/api/mail/blobs/b1?name=photo.png&type=image%2Fpng");
    expect(screen.queryByTestId("pdf-thumbnail")).not.toBeInTheDocument();
  });

  it("renders PdfThumbnail for a pdf attachment", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })} />);

    expect(screen.getByTestId("pdf-thumbnail")).toHaveAttribute("data-blob-id", "b1");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("passes a compact branded CefiroLoader as PdfThumbnail's loading fallback (GH #94)", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })} />);

    const loadingFallback = screen.getByTestId("pdf-thumbnail-loading-fallback");
    expect(within(loadingFallback).getByRole("status")).toBeInTheDocument();
  });

  it("keeps the static file icon as PdfThumbnail's error fallback, so a permanently failed PDF never spins forever (GH #94 regression)", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })} />);

    const errorFallback = screen.getByTestId("pdf-thumbnail-error-fallback");
    expect(within(errorFallback).queryByRole("status")).not.toBeInTheDocument();
    expect(errorFallback.querySelector("svg")).toBeTruthy();
  });

  it("renders a blank icon card (no img, no PdfThumbnail) for a non-previewable type", () => {
    render(
      <AttachmentCard
        attachment={makeAttachment({
          name: "sheet.xlsx",
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        })}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pdf-thumbnail")).not.toBeInTheDocument();
  });

  it("shows a file-type icon next to the name in the footer row", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })} />);

    const nameText = screen.getByText(/report\.pdf/);
    expect(nameText.parentElement?.querySelector("svg")).toBeTruthy();
  });

  it("shows the download link for every attachment", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "sheet.csv", type: "text/csv" })} />);

    const link = screen.getByRole("link", { name: i18n.t("attachments.download") });
    expect(link).toHaveAttribute("href", "/api/mail/blobs/b1?name=sheet.csv&type=text%2Fcsv&dl=1");
  });

  it("shows a 'Ver' control only for previewable types (image/pdf), as a button (not a new-tab link)", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })} />);

    const viewButton = screen.getByRole("button", { name: i18n.t("attachments.view") });
    expect(viewButton).toHaveAttribute("type", "button");
    expect(screen.queryByRole("link", { name: i18n.t("attachments.view") })).not.toBeInTheDocument();
  });

  it("hides the view control for a non-previewable type", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "sheet.csv", type: "text/csv" })} />);

    expect(screen.queryByRole("button", { name: i18n.t("attachments.view") })).not.toBeInTheDocument();
  });

  it("opens the in-app viewer for the attachment when 'Ver' is clicked", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })} />);

    expect(screen.queryByTestId("attachment-viewer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("attachments.view") }));

    expect(screen.getByTestId("attachment-viewer")).toHaveAttribute("data-blob-id", "b1");
  });

  it("opens the in-app viewer when the thumbnail itself is clicked, for a previewable attachment", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "photo.png", type: "image/png" })} />);

    fireEvent.click(screen.getByTestId("attachment-card-thumbnail"));

    expect(screen.getByTestId("attachment-viewer")).toHaveAttribute("data-blob-id", "b1");
  });

  it("closes the viewer when the mock viewer's onClose fires", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "photo.png", type: "image/png" })} />);

    fireEvent.click(screen.getByTestId("attachment-card-thumbnail"));
    expect(screen.getByTestId("attachment-viewer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "mock-close" }));
    expect(screen.queryByTestId("attachment-viewer")).not.toBeInTheDocument();
  });

  it("renders a non-interactive (button-less) thumbnail for a non-previewable type, and never opens the viewer", () => {
    render(
      <AttachmentCard
        attachment={makeAttachment({
          name: "sheet.xlsx",
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        })}
      />,
    );

    const thumbnail = screen.getByTestId("attachment-card-thumbnail");
    expect(thumbnail.tagName).toBe("DIV");

    fireEvent.click(thumbnail);
    expect(screen.queryByTestId("attachment-viewer")).not.toBeInTheDocument();
  });

  it("falls back to a generic name when the attachment has none", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: null, type: "text/csv" })} />);

    expect(screen.getByText(/attachment/)).toBeInTheDocument();
  });

  it("lazy-loads the image thumbnail", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "photo.png", type: "image/png" })} />);

    expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute("loading", "lazy");
  });

  it("swaps the image thumbnail for the generic file-type icon if it fails to load, never a broken image glyph", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "photo.png", type: "image/png" })} />);

    const thumbnail = screen.getByTestId("attachment-card-thumbnail");
    const img = within(thumbnail).getByRole("img", { name: "photo.png" });
    expect(within(thumbnail).queryByRole("img")).toBeInTheDocument();
    expect(thumbnail.querySelector("svg")).toBeFalsy();

    fireEvent.error(img);

    expect(within(thumbnail).queryByRole("img")).not.toBeInTheDocument();
    expect(thumbnail.querySelector("svg")).toBeTruthy();
  });

  describe("onRemove (optional)", () => {
    it("renders no remove button when onRemove is not provided — unchanged reader behavior", () => {
      render(<AttachmentCard attachment={makeAttachment({ name: "photo.png" })} />);

      expect(screen.queryByTestId("attachment-card-remove")).not.toBeInTheDocument();
    });

    it("renders a remove button with a named aria-label and calls onRemove when clicked, when provided", () => {
      const onRemove = vi.fn();
      render(
        <AttachmentCard attachment={makeAttachment({ name: "photo.png" })} onRemove={onRemove} />,
      );

      const removeButton = screen.getByTestId("attachment-card-remove");
      expect(removeButton).toHaveAttribute("aria-label", i18n.t("attachments.remove", { name: "photo.png" }));

      fireEvent.click(removeButton);

      expect(onRemove).toHaveBeenCalledTimes(1);
    });
  });
});

// #348: formatSizeKb printed "1024.0 KB" instead of rolling over to MB once
// a file crossed the 1 MB mark — Intl.NumberFormat, plus a KB/MB switch,
// fixes both the ugly trailing zero and the missing unit rollover.
describe("formatSizeKb", () => {
  it("formats a sub-1MB size in KB", () => {
    expect(formatSizeKb(2048)).toBe("2 KB");
  });

  it("keeps one decimal for a fractional KB size", () => {
    expect(formatSizeKb(1536)).toBe("1.5 KB");
  });

  it("rolls over to MB at the 1 MB boundary instead of printing 1024 KB", () => {
    expect(formatSizeKb(1024 * 1024)).toBe("1 MB");
  });

  it("formats a multi-MB size in MB with a decimal, not thousands of KB", () => {
    expect(formatSizeKb(1024 * 1024 * 5.5)).toBe("5.5 MB");
  });
});

// #349: PdfThumbnail fetches the whole PDF and pulls in an extra ~1MB pdf.js
// chunk the moment it mounts, and the image thumbnail's <img> fetches the
// full attachment — both used to fire immediately for every attachment card
// on screen, so a thread with 10 attachments meant 10 full downloads at
// once. Gated behind useInViewport (app/ui/useInViewport.ts) instead.
describe("AttachmentCard thumbnail viewport gating", () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not render the real PdfThumbnail until the card scrolls into view", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })} />);

    expect(screen.queryByTestId("pdf-thumbnail")).not.toBeInTheDocument();

    const observer = FakeIntersectionObserver.instances[0]!;
    act(() => observer.intersect(observer.observed[0]!, true));

    expect(screen.getByTestId("pdf-thumbnail")).toHaveAttribute("data-blob-id", "b1");
  });

  it("does not render the real <img> until the card scrolls into view", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "photo.png", type: "image/png" })} />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    const observer = FakeIntersectionObserver.instances[0]!;
    act(() => observer.intersect(observer.observed[0]!, true));

    expect(screen.getByRole("img", { name: "photo.png" })).toBeInTheDocument();
  });
});
