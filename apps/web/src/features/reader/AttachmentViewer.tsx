import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AttachmentMeta } from "@webmail/shared";
import { CloseIcon } from "../../app/ui/icons";
import { useFocusTrap } from "../../app/ui/useFocusTrap";

interface AttachmentViewerProps {
  /**
   * The attachment to preview, or `null` to keep the viewer closed. Kept as
   * a single nullable prop (rather than a separate `open` boolean) because
   * the viewer is always opened *for* a specific attachment — there is no
   * meaningful "open" state without one, mirroring how ShortcutsOverlay uses
   * `open` for its (attachment-less) static content.
   */
  attachment: AttachmentMeta | null;
  /**
   * Which previewable kind `attachment` is. Callers (AttachmentCard) only
   * ever open this viewer for "image" or "pdf" attachments — non-previewable
   * types stay download-only and never reach this component.
   */
  kind: "image" | "pdf";
  onClose: () => void;
}

// Only used for the Descargar link — a real, credential-carrying navigation
// straight to the blob endpoint (dl=1 forces Content-Disposition:
// attachment), which needs no object-URL indirection since nothing renders
// or executes as part of a download.
function downloadUrl(blobId: string, name: string, type: string): string {
  const query = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  return `/api/mail/blobs/${encodeURIComponent(blobId)}?${query}&dl=1`;
}

// Fetches raw bytes to build an object URL from — no dl=1 (this isn't a
// download). Mirrors PdfThumbnail's blobFetchUrl.
function blobFetchUrl(blobId: string, name: string, type: string): string {
  const query = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  return `/api/mail/blobs/${encodeURIComponent(blobId)}?${query}`;
}

/**
 * Gmail-style in-app attachment viewer: a full-screen overlay that previews
 * an image or PDF attachment inline (instead of the old "open a new tab"
 * behavior), with Descargar/Imprimir/Cerrar controls in a header bar.
 *
 * The blob endpoint sends `Content-Security-Policy: sandbox` with no tokens
 * on every response (see apps/server/src/modules/mail/router.ts) — a
 * deliberate, shared XSS defense that must not be relaxed here. Pointing an
 * `<img>`/`<iframe>` directly at that URL puts the loaded document in an
 * opaque (cross-origin-to-us) origin, which breaks two things: Chrome's
 * native PDF viewer needs script execution the sandbox denies (renders
 * blank / forces a download instead), and `iframe.contentWindow.print()`
 * throws a SecurityError across an opaque origin.
 *
 * The fix is client-side: fetch the bytes ourselves (the *main app
 * document* is authenticated and unrestricted, so `fetch(..., {
 * credentials: "include" })` against the same blob URL works fine), then
 * hand the app its own `Blob`/`URL.createObjectURL()` object URL. A `blob:`
 * object URL is same-origin to the document that created it and carries
 * none of the server's CSP header, so the native PDF viewer renders
 * normally and `contentWindow.print()` is genuinely same-origin. Restricted
 * to the already-gated previewable set (image/pdf) — the content-type comes
 * from server-verified attachment metadata, never from email HTML, and
 * neither an image nor a PDF (PDF scripting is itself sandboxed by the
 * viewer) can execute script, so this never creates a `text/html` (or
 * similar) object URL.
 *
 * Printing goes through an iframe's `contentWindow.print()` in both cases:
 * for a PDF that's the same visible iframe already showing the document;
 * images (a plain `<img>`, no iframe on screen) get a second, visually
 * hidden iframe pointed at the same object URL purely to print from — the
 * well-known "hidden print iframe" technique (kept in normal flow, just
 * zero-sized and positioned off-canvas, never `display:none`, since a
 * `display:none` subtree never gets laid out and would print blank).
 * Imprimir stays disabled until that iframe's `onLoad` fires, so a click
 * can never print a still-loading (blank) document.
 */
export function AttachmentViewer({ attachment, kind, onClose }: AttachmentViewerProps) {
  const { t } = useTranslation();
  const printFrameRef = useRef<HTMLIFrameElement>(null);
  const open = attachment !== null;
  // GH #158: focus-in/Tab-cycling/restore-on-close now come from the shared
  // useFocusTrap primitive — this component used to hand-roll all three.
  const dialogRef = useFocusTrap<HTMLDivElement>(open);

  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [printReady, setPrintReady] = useState(false);

  // Fetches the attachment's bytes credentialed (same as PdfThumbnail) and
  // turns them into a same-origin object URL — see the module docstring for
  // why this indirection exists at all. Async and racy by nature (the user
  // can close/switch attachments mid-fetch): `isCurrent` bails at every
  // await boundary once stale, and the object URL created by *this* effect
  // run (if any) is always revoked on cleanup — normal close, an attachment
  // switch, or unmount — so nothing leaks.
  useEffect(() => {
    if (!attachment) return;
    let isCurrent = true;
    let createdUrl: string | null = null;
    setStatus("loading");
    setObjectUrl(null);
    setPrintReady(false);

    const name = attachment.name ?? "attachment";
    const type = attachment.type;

    fetch(blobFetchUrl(attachment.blobId, name, type), { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(`blob fetch failed: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        if (!isCurrent) return;
        const url = URL.createObjectURL(new Blob([buffer], { type }));
        createdUrl = url;
        setObjectUrl(url);
        setStatus("ready");
      })
      .catch(() => {
        if (isCurrent) setStatus("error");
      });

    return () => {
      isCurrent = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [attachment?.blobId, attachment?.type, attachment?.name]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!attachment) return null;

  const name = attachment.name ?? "attachment";

  function handlePrint() {
    if (!printReady) return;
    try {
      printFrameRef.current?.contentWindow?.print();
    } catch {
      // A same-origin object URL should never throw here, but print() is a
      // browser-driven API outside our control — fail silently rather than
      // crash the viewer if it ever does.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="flex h-[85vh] w-[90vw] max-w-[1000px] flex-col overflow-hidden rounded-[14px] border border-line bg-panel shadow-pop outline-none"
      >
        <div className="flex items-center gap-4 border-b border-line px-5 py-3">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{name}</span>
          <a
            href={downloadUrl(attachment.blobId, name, attachment.type)}
            className="shrink-0 text-[13px] font-semibold text-accent-text underline"
          >
            {t("attachments.download")}
          </a>
          <button
            type="button"
            onClick={handlePrint}
            disabled={!printReady}
            className="shrink-0 text-[13px] font-semibold text-accent-text underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
          >
            {t("attachments.print")}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("attachments.close")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-hover"
          >
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="relative flex flex-1 items-center justify-center overflow-auto bg-soft">
          {status === "loading" && (
            <p role="status" className="text-[13px] text-muted">
              {t("attachments.previewLoading")}
            </p>
          )}
          {status === "error" && (
            <p role="alert" className="text-[13px] text-danger">
              {t("attachments.previewError")}
            </p>
          )}
          {status === "ready" && objectUrl && kind === "image" && (
            <>
              <img src={objectUrl} alt={name} className="max-h-full max-w-full object-contain" />
              {/* Print-only target — see the module docstring for why images
                  get their own hidden iframe instead of reusing window.print(). */}
              <iframe
                ref={printFrameRef}
                data-print-frame="true"
                title={name}
                src={objectUrl}
                onLoad={() => setPrintReady(true)}
                className="fixed bottom-0 right-0 h-0 w-0 border-0"
              />
            </>
          )}
          {status === "ready" && objectUrl && kind === "pdf" && (
            <iframe
              ref={printFrameRef}
              title={name}
              src={objectUrl}
              onLoad={() => setPrintReady(true)}
              className="h-full w-full border-0 bg-white"
            />
          )}
        </div>
      </div>
    </div>
  );
}
