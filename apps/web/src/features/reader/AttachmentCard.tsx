import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AttachmentMeta } from "@webmail/shared";
import { CefiroLoader } from "../../app/ui/CefiroLoader";
import {
  CloseIcon,
  FileArchiveIcon,
  FileCalendarIcon,
  FileDocumentIcon,
  FileGenericIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
} from "../../app/ui/icons";
import { AttachmentViewer } from "./AttachmentViewer";
import { blobUrl } from "./blobUrl";
import { PdfThumbnail } from "./PdfThumbnail";

interface AttachmentCardProps {
  attachment: AttachmentMeta;
  // Optional: when provided, a small remove/X button is rendered on the
  // card (used by the composer to drop a not-yet-sent attachment). Omitted
  // by the reader's usage (ThreadView), which never removes attachments —
  // that usage renders unchanged.
  onRemove?: () => void;
  // GH #13/#50: the active shared mailbox this attachment belongs to, so its
  // blob is fetched/downloaded from that account. Absent = personal mailbox.
  accountId?: string;
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

// #348: printed "1024.0 KB" for a 1MB+ attachment instead of rolling over to
// MB — Intl.NumberFormat drops the trailing ".0" for a whole number, and the
// KB/MB switch at the 1MB boundary keeps the number itself from ever reading
// as "a thousand-plus". Locale fixed to "en-US" rather than the active UI
// language: "KB"/"MB" are themselves untranslated English abbreviations
// (like every other size unit in this codebase), so the digits next to them
// stay in the same convention instead of switching decimal separator with
// the interface language.
const SIZE_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatSizeKb(sizeBytes: number): string {
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${SIZE_FORMATTER.format(kb)} KB`;
  return `${SIZE_FORMATTER.format(kb / 1024)} MB`;
}

// Gmail-style attachment card: a thumbnail/preview area on top (a real
// image, a pdf.js-rendered first page, or a blank icon area for anything
// else), and a footer row with the file-type icon, name (size), and the
// download/view actions.
export function AttachmentCard({ attachment, onRemove, accountId }: AttachmentCardProps) {
  const { t } = useTranslation();
  const name = attachment.name ?? "attachment";
  const kind = attachmentThumbnailKind(attachment.type);
  const Icon = attachmentIconFor(attachment.type);
  const previewable = kind !== "icon";
  // Narrows `kind` to what AttachmentViewer accepts. Only ever read while
  // `viewerOpen` is true, which the thumbnail/"Ver" handlers below only ever
  // set for a previewable (image/pdf) attachment — `null` here is the
  // (unreachable in practice) "not previewable" case, kept just so the
  // viewer prop stays fully typed without an unsafe cast.
  const previewKind: "image" | "pdf" | null = kind === "icon" ? null : kind;

  // A blob that classifies as an image type can still fail to actually load
  // (corrupt bytes, a transient fetch error, ...) — onError swaps to the
  // same generic file-type icon PdfThumbnail falls back to, so this card
  // never shows the browser's broken-image glyph either.
  const [imageFailed, setImageFailed] = useState(false);

  // Gmail-style in-app viewer instead of the old "open a new tab" behavior —
  // opened by either the thumbnail or the "Ver" control, for previewable
  // (image/pdf) attachments only. See AttachmentViewer.tsx.
  const [viewerOpen, setViewerOpen] = useState(false);

  const thumbnailContent = (
    <>
      {kind === "image" && !imageFailed && (
        <img
          src={blobUrl(attachment.blobId, name, attachment.type, { accountId })}
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
          accountId={accountId}
          // GH #94: a slow-rendering PDF thumbnail shows the branded Céfiro
          // loader (compact, no label — this card is small) while pdf.js is
          // still working. A PERMANENTLY failed PDF instead keeps the plain
          // static file icon (fallback, the error state) — never the
          // animated loader, so a failed PDF doesn't spin forever.
          loadingFallback={<CefiroLoader size={20} />}
          fallback={<Icon size={32} />}
        />
      )}
      {(kind === "icon" || (kind === "image" && imageFailed)) && <Icon size={32} />}
    </>
  );

  return (
    <div className="relative flex w-[172px] shrink-0 flex-col overflow-hidden rounded-xl border border-line">
      {onRemove && (
        <button
          type="button"
          data-testid="attachment-card-remove"
          aria-label={t("attachments.remove", { name })}
          onClick={onRemove}
          className="absolute right-1 top-1 z-10 rounded-full bg-ink/70 p-1 text-canvas transition hover:bg-ink"
        >
          <CloseIcon size={12} />
        </button>
      )}
      {previewable ? (
        <button
          type="button"
          data-testid="attachment-card-thumbnail"
          onClick={() => setViewerOpen(true)}
          aria-label={t("attachments.viewNamed", { name })}
          className="flex h-[104px] items-center justify-center bg-soft"
        >
          {thumbnailContent}
        </button>
      ) : (
        <div data-testid="attachment-card-thumbnail" className="flex h-[104px] items-center justify-center bg-soft">
          {thumbnailContent}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line bg-panel px-2 py-1.5 text-xs">
        <Icon size={15} />
        <span className="min-w-0 flex-1 truncate">
          {name} ({formatSizeKb(attachment.size)})
        </span>
        <a
          href={blobUrl(attachment.blobId, name, attachment.type, { download: true, accountId })}
          className="text-accent-text underline"
        >
          {t("attachments.download")}
        </a>
        {previewable && (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className="text-accent-text underline"
          >
            {t("attachments.view")}
          </button>
        )}
      </div>
      <AttachmentViewer
        attachment={viewerOpen ? attachment : null}
        kind={previewKind ?? "image"}
        accountId={accountId}
        onClose={() => setViewerOpen(false)}
      />
    </div>
  );
}
