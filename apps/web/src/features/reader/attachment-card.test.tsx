import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentMeta } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AttachmentCard, attachmentThumbnailKind } from "./AttachmentCard";

// PdfThumbnail itself does real pdf.js work (covered separately, with its
// own dynamic-import mocking, in pdf-thumbnail.test.tsx) — here we only care
// that AttachmentCard *chooses* PdfThumbnail for pdf attachments, so it's
// swapped for a cheap marker.
vi.mock("./PdfThumbnail", () => ({
  PdfThumbnail: ({ blobId }: { blobId: string }) => <div data-testid="pdf-thumbnail" data-blob-id={blobId} />,
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

  it("shows the view link only for previewable types (image/pdf)", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "report.pdf", type: "application/pdf" })} />);

    const viewLink = screen.getByRole("link", { name: i18n.t("attachments.view") });
    expect(viewLink).toHaveAttribute("href", "/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf");
    expect(viewLink).toHaveAttribute("target", "_blank");
  });

  it("hides the view link for a non-previewable type", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: "sheet.csv", type: "text/csv" })} />);

    expect(screen.queryByRole("link", { name: i18n.t("attachments.view") })).not.toBeInTheDocument();
  });

  it("falls back to a generic name when the attachment has none", () => {
    render(<AttachmentCard attachment={makeAttachment({ name: null, type: "text/csv" })} />);

    expect(screen.getByText(/attachment/)).toBeInTheDocument();
  });
});
