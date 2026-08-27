import { useEffect, useRef, useState, type ReactNode } from "react";
// A Vite asset URL — this only imports a string (the built worker file's
// final path), never the pdf.js library itself, so it costs nothing in the
// initial bundle. See the module docstring below for why the library is
// loaded separately, via dynamic import().
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
// Type-only — erased at compile time (verbatimModuleSyntax), so this costs
// nothing either; it's just used to type the destroy-on-cleanup ref below.
// Note: destroy() lives on the *loading task* returned by getDocument(),
// not on the resolved PDFDocumentProxy — that class has no public destroy.
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import { blobUrl } from "./blobUrl";

interface PdfThumbnailProps {
  blobId: string;
  name: string;
  type: string;
  // GH #13/#50: the active shared mailbox this PDF belongs to, so its bytes are
  // fetched from that account. Absent = personal mailbox.
  accountId?: string;
  /**
   * Rendered if the PDF permanently fails to load or render — network
   * failure, corrupt/encrypted PDF, no canvas support, etc. This component
   * only ever shows the real rendered thumbnail, `loadingFallback`, or this
   * error fallback, never a broken image.
   *
   * Also used while loading when `loadingFallback` is omitted, matching this
   * component's original (pre GH #94) behavior of a single placeholder
   * throughout.
   */
  fallback: ReactNode;
  /**
   * Rendered while the PDF is actively loading (fetching/parsing/rendering),
   * before it has either succeeded or permanently failed. GH #94: kept
   * distinct from `fallback` (the error state) so a caller can point this at
   * an animated "loading" indicator without that indicator spinning forever
   * on a PDF that has actually failed — this component already tracks that
   * distinction internally, this prop just exposes it.
   */
  loadingFallback?: ReactNode;
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
 *
 * Each loaded PDF owns a worker/document on the pdf.js side — left open, it
 * leaks one per rendered thumbnail as the user switches messages. `taskRef`
 * tracks the currently-open loading task so it can be destroyed both right
 * after the thumbnail is painted (we only ever needed page 1's bitmap, not
 * the whole document) and, as a backstop, from the effect's cleanup if the
 * component unmounts or the attachment changes before rendering gets that
 * far.
 */
export function PdfThumbnail({ blobId, name, type, accountId, fallback, loadingFallback }: PdfThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  // GH #94: was a plain `ready` boolean — widened to a 3-state status so the
  // render below can tell "still loading" apart from "permanently failed"
  // (both used to collapse into the same `!ready` fallback). The underlying
  // fetch/render/cleanup pipeline below is unchanged; only the state it sets
  // gained a name for its failure case instead of folding back to false.
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let isCurrent = true;
    setStatus("loading");
    taskRef.current = null;

    async function renderThumbnail() {
      try {
        const response = await fetch(blobUrl(blobId, name, type, { accountId }), { credentials: "include" });
        if (!response.ok) throw new Error(`blob fetch failed: ${response.status}`);
        const data = await response.arrayBuffer();
        if (!isCurrent) return;

        const pdfjsLib = await import("pdfjs-dist");
        if (!isCurrent) return;
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

        // getDocument() returns the loading task synchronously — destroy()
        // lives here, not on the PDFDocumentProxy its .promise resolves to.
        const loadingTask = pdfjsLib.getDocument({ data });
        taskRef.current = loadingTask;

        const pdf = await loadingTask.promise;
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
        setStatus("ready");

        // The rendered bitmap is all this component ever needed — release
        // the document (and its worker-side resources) right away instead
        // of holding it open for the thumbnail's remaining lifetime.
        taskRef.current = null;
        await loadingTask.destroy();
      } catch {
        // Network failure, corrupt/encrypted PDF, no canvas support,
        // whatever — this is a permanent failure for this attachment (no
        // further state change coming), so it renders the error fallback,
        // never the loading one and never a broken image.
        if (isCurrent) setStatus("error");
      }
    }

    renderThumbnail();

    return () => {
      isCurrent = false;
      if (taskRef.current) {
        void taskRef.current.destroy();
        taskRef.current = null;
      }
    };
  }, [blobId, name, type, accountId]);

  // Falls back to `fallback` while loading too when `loadingFallback` isn't
  // given — matches this component's original single-placeholder behavior
  // for callers that don't need the two states told apart.
  const pendingNode = status === "loading" ? (loadingFallback ?? fallback) : fallback;

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      {status !== "ready" && pendingNode}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={status === "ready" ? "max-h-full max-w-full object-contain" : "hidden"}
      />
    </div>
  );
}
