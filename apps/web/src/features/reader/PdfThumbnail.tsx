import { useEffect, useRef, useState, type ReactNode } from "react";
// A Vite asset URL — this only imports a string (the built worker file's
// final path), never the pdf.js library itself, so it costs nothing in the
// initial bundle. See the module docstring below for why the library is
// loaded separately, via dynamic import().
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

interface PdfThumbnailProps {
  blobId: string;
  name: string;
  type: string;
  /**
   * Rendered while the PDF is loading, and again if anything along the way
   * fails — this component only ever shows the real rendered thumbnail or
   * this fallback, never a broken image.
   */
  fallback: ReactNode;
}

function blobFetchUrl(blobId: string, name: string, type: string): string {
  const query = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  // No dl=1 — this fetches bytes to render, not to download.
  return `/api/mail/blobs/${encodeURIComponent(blobId)}?${query}`;
}

// Caps the rendered canvas so a large PDF page never produces an oversized
// bitmap for what is only a small card thumbnail.
const MAX_WIDTH = 160;
const MAX_HEIGHT = 160;

/**
 * Renders a PDF attachment's first page onto a small canvas via pdf.js.
 *
 * pdf.js (~1MB+) is dynamic-`import()`ed here, inside the mount effect, so
 * it is never part of the initial app bundle — only actually mounting a
 * PdfThumbnail (i.e. a PDF attachment card is on screen) pulls it in, as a
 * separate chunk.
 *
 * Async and racy by nature (the user can switch messages/attachments
 * mid-fetch or mid-render): each effect run captures its own `isCurrent`
 * flag and bails at every await boundary once stale, so a slow, now
 * irrelevant render can never land on the canvas for a different
 * attachment.
 */
export function PdfThumbnail({ blobId, name, type, fallback }: PdfThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    setReady(false);

    async function renderThumbnail() {
      try {
        const response = await fetch(blobFetchUrl(blobId, name, type), { credentials: "include" });
        if (!response.ok) throw new Error(`blob fetch failed: ${response.status}`);
        const data = await response.arrayBuffer();
        if (!isCurrent) return;

        const pdfjsLib = await import("pdfjs-dist");
        if (!isCurrent) return;
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

        const pdf = await pdfjsLib.getDocument({ data }).promise;
        if (!isCurrent) return;
        const page = await pdf.getPage(1);
        if (!isCurrent) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(MAX_WIDTH / baseViewport.width, MAX_HEIGHT / baseViewport.height, 1);
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvas, viewport }).promise;
        if (!isCurrent) return;
        setReady(true);
      } catch {
        // Network failure, corrupt/encrypted PDF, no canvas support,
        // whatever — stay on the fallback icon rather than ever showing a
        // broken preview.
        if (isCurrent) setReady(false);
      }
    }

    renderThumbnail();

    return () => {
      isCurrent = false;
    };
  }, [blobId, name, type]);

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      {!ready && fallback}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={ready ? "max-h-full max-w-full object-contain" : "hidden"}
      />
    </div>
  );
}
