import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AttachmentMeta } from "@webmail/shared";
import {
  FileArchiveIcon,
  FileCalendarIcon,
  FileDocumentIcon,
  FileGenericIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
} from "../../app/ui/icons";
import { PdfThumbnail } from "./PdfThumbnail";

interface AttachmentCardProps {
  attachment: AttachmentMeta;
}

export type AttachmentThumbnailKind = "image" | "pdf" | "icon";

// Types that get a real <img> thumbnail. Mirrors the server's
// SAFE_INLINE_CONTENT_TYPES image subset (apps/server/src/modules/mail/router.ts).
const IMAGE_THUMBNAIL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const WORD_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const SHEET_TYPES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const ARCHIVE_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
]);
const CALENDAR_TYPES = new Set(["text/calendar", "application/ics"]);

function normalizeType(type: string): string {
  return type.split(";")[0]?.trim().toLowerCase() ?? "";
}

// Decides which thumbnail a card shows: a real <img> for images, a
// pdf.js-rendered first-page preview for PDFs, and a plain icon card for
// everything else (Word/Excel/ZIP/etc. can't be previewed in-browser).
//
// This exactly mirrors the server's SAFE_INLINE_CONTENT_TYPES allowlist —
// "kind !== icon" below also doubles as the "Ver" (preview) link's
// visibility rule in AttachmentCard, so the two decisions can never drift
// apart the way two separately-maintained lists could.
export function attachmentThumbnailKind(type: string): AttachmentThumbnailKind {
  const normalized = normalizeType(type);
  if (IMAGE_THUMBNAIL_TYPES.has(normalized)) return "image";
  if (normalized === "application/pdf") return "pdf";
  return "icon";
}

// Maps an attachment's content-type to the icon that best represents it —
// pdf/word share the document icon, spreadsheets get a grid, archives a
// zipper mark; anything unrecognized (including plain text/JSON) falls back
// to the generic file icon.
function attachmentIconFor(type: string) {
  const normalized = normalizeType(type);
  if (normalized.startsWith("image/")) return FileImageIcon;
  if (normalized === "application/pdf" || WORD_TYPES.has(normalized)) return FileDocumentIcon;
  if (SHEET_TYPES.has(normalized)) return FileSpreadsheetIcon;
  if (ARCHIVE_TYPES.has(normalized)) return FileArchiveIcon;
  if (CALENDAR_TYPES.has(normalized)) return FileCalendarIcon;
  return FileGenericIcon;
}

function formatSizeKb(size: number) {
  return `${(size / 1024).toFixed(1)} KB`;
}

function blobUrl(blobId: string, name: string, type: string, download: boolean): string {
  const query = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  return `/api/mail/blobs/${encodeURIComponent(blobId)}?${query}${download ? "&dl=1" : ""}`;
}

// Gmail-style attachment card: a thumbnail/preview area on top (a real
// image, a pdf.js-rendered first page, or a blank icon area for anything
// else), and a footer row with the file-type icon, name (size), and the
// download/view actions.
export function AttachmentCard({ attachment }: AttachmentCardProps) {
  const { t } = useTranslation();
  const name = attachment.name ?? "attachment";
  const kind = attachmentThumbnailKind(attachment.type);
  const Icon = attachmentIconFor(attachment.type);
  const previewable = kind !== "icon";

  // A blob that classifies as an image type can still fail to actually load
  // (corrupt bytes, a transient fetch error, ...) — onError swaps to the
  // same generic file-type icon PdfThumbnail falls back to, so this card
  // never shows the browser's broken-image glyph either.
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <div className="flex w-[172px] shrink-0 flex-col overflow-hidden rounded-xl border border-line">
      <div data-testid="attachment-card-thumbnail" className="flex h-[104px] items-center justify-center bg-soft">
        {kind === "image" && !imageFailed && (
          <img
            src={blobUrl(attachment.blobId, name, attachment.type, false)}
            alt={name}
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover"
          />
        )}
        {kind === "pdf" && (
          <PdfThumbnail
            blobId={attachment.blobId}
            name={name}
            type={attachment.type}
            fallback={<Icon size={32} />}
          />
        )}
        {(kind === "icon" || (kind === "image" && imageFailed)) && <Icon size={32} />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line bg-panel px-2 py-1.5 text-xs">
        <Icon size={15} />
        <span className="min-w-0 flex-1 truncate">
          {name} ({formatSizeKb(attachment.size)})
        </span>
        <a href={blobUrl(attachment.blobId, name, attachment.type, true)} className="text-accent-text underline">
          {t("attachments.download")}
        </a>
        {previewable && (
          <a
            href={blobUrl(attachment.blobId, name, attachment.type, false)}
            target="_blank"
            rel="noreferrer"
            className="text-accent-text underline"
          >
            {t("attachments.view")}
          </a>
        )}
      </div>
    </div>
  );
}
