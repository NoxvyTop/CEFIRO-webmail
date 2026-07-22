import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfThumbnail } from "./PdfThumbnail";

// Real pdf.js is heavy and does real canvas/worker rendering, which jsdom
// can't do — see the module docstring on PdfThumbnail.tsx. These tests pin
// the things that ARE meaningfully testable outside a real browser:
//  1. the fallback is shown while loading and on any failure (never a
//     broken image),
//  2. the render pipeline correctly bails on a stale (superseded)
//     attachment instead of painting over the current one (race safety),
//     and
//  3. the loading task is destroyed once painted and on teardown, so a
//     worker/document is never leaked per rendered thumbnail.
// Actual first-page rendering fidelity is verified manually in a real
// browser (see the implementation report).

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

// Loosely typed on purpose — these are hand-rolled fakes of pdf.js's
// loading-task/document/page/render pipeline, not real
// PDFDocumentLoadingTask/PDFDocumentProxy/PDFPageProxy instances, so pinning
// them to pdfjs-dist's real (much larger) types would just fight the mock
// rather than help it.
//
// `destroy` belongs on the object getDocument() returns *synchronously*
// (the loading task) — not on the object its `.promise` resolves to (the
// document proxy) — mirroring the real pdf.js API. Every fake loading task
// includes it: the component always calls it, so a mock missing it would
// throw and get swallowed by the component's own try/catch, silently
// breaking unrelated tests.
function mockPdfjs(overrides: { getDocument?: (...args: unknown[]) => unknown } = {}) {
  vi.doMock("pdfjs-dist", () => ({
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument:
      overrides.getDocument ??
      vi.fn(() => ({
        destroy: vi.fn(() => Promise.resolve()),
        promise: Promise.resolve({
          getPage: vi.fn(async () => ({
            getViewport: () => ({ width: 100, height: 140 }),
            render: vi.fn(() => ({ promise: Promise.resolve() })),
          })),
        }),
      })),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("pdfjs-dist");
  vi.resetModules();
});

describe("PdfThumbnail", () => {
  it("shows the fallback while the PDF is still loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    mockPdfjs();

    render(
      <PdfThumbnail blobId="b1" name="report.pdf" type="application/pdf" fallback={<span>fallback-icon</span>} />,
    );

    expect(screen.getByText("fallback-icon")).toBeInTheDocument();
  });

  it("falls back to the icon (never a broken image) when the blob fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    mockPdfjs();

    render(
      <PdfThumbnail blobId="b1" name="report.pdf" type="application/pdf" fallback={<span>fallback-icon</span>} />,
    );

    await waitFor(() => expect(screen.getByText("fallback-icon")).toBeInTheDocument());
  });

  it("falls back to the icon when pdf.js fails to parse the document", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF_BYTES, { status: 200 })));
    mockPdfjs({
      getDocument: vi.fn(() => ({
        destroy: vi.fn(() => Promise.resolve()),
        promise: Promise.reject(new Error("invalid pdf")),
      })),
    });

    render(
      <PdfThumbnail blobId="b1" name="report.pdf" type="application/pdf" fallback={<span>fallback-icon</span>} />,
    );

    await waitFor(() => expect(screen.getByText("fallback-icon")).toBeInTheDocument());
  });

  it("fetches the blob credentialed, without a download flag", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(PDF_BYTES, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mockPdfjs();

    render(
      <PdfThumbnail blobId="b1" name="report.pdf" type="application/pdf" fallback={<span>fallback-icon</span>} />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/mail/blobs/b1?name=report.pdf&type=application%2Fpdf");
    expect(init).toEqual(expect.objectContaining({ credentials: "include" }));
  });

  it("hides the fallback and swaps in the canvas once pdf.js renders page 1 successfully", async () => {
    const renderMock = vi.fn(() => ({ promise: Promise.resolve() }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF_BYTES, { status: 200 })));
    mockPdfjs({
      getDocument: vi.fn(() => ({
        destroy: vi.fn(() => Promise.resolve()),
        promise: Promise.resolve({
          getPage: vi.fn(async () => ({
            getViewport: () => ({ width: 100, height: 140 }),
            render: renderMock,
          })),
        }),
      })),
    });

    render(
      <PdfThumbnail blobId="b1" name="report.pdf" type="application/pdf" fallback={<span>fallback-icon</span>} />,
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("fallback-icon")).not.toBeInTheDocument());
  });

  it("does not let a stale (superseded) attachment's slow render land after the attachment has changed", async () => {
    let resolveFirstFetch: ((response: Response) => void) | undefined;
    const firstFetchPromise = new Promise<Response>((resolve) => {
      resolveFirstFetch = resolve;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("first-blob")) return firstFetchPromise;
      return Promise.resolve(new Response(PDF_BYTES, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const getDocumentMock = vi.fn(() => ({
      destroy: vi.fn(() => Promise.resolve()),
      promise: Promise.resolve({
        getPage: vi.fn(async () => ({
          getViewport: () => ({ width: 100, height: 140 }),
          render: vi.fn(() => ({ promise: Promise.resolve() })),
        })),
      }),
    }));
    mockPdfjs({ getDocument: getDocumentMock });

    const { rerender } = render(
      <PdfThumbnail blobId="first-blob" name="a.pdf" type="application/pdf" fallback={<span>fallback-icon</span>} />,
    );

    // The message changes (e.g. user opened another thread) before the
    // first attachment's slow fetch has resolved.
    rerender(
      <PdfThumbnail
        blobId="second-blob"
        name="b.pdf"
        type="application/pdf"
        fallback={<span>fallback-icon</span>}
      />,
    );

    await waitFor(() => expect(getDocumentMock).toHaveBeenCalledTimes(1));

    // The stale first attachment's fetch resolves only now, well after the
    // component already moved on to the second attachment.
    resolveFirstFetch?.(new Response(PDF_BYTES, { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // A missing race guard would have the stale effect proceed to call
    // getDocument a second time (for the now-irrelevant first attachment).
    expect(getDocumentMock).toHaveBeenCalledTimes(1);
  });

  describe("document lifecycle (avoids leaking a worker/document per rendered thumbnail)", () => {
    it("destroys the loading task once the thumbnail has rendered, instead of holding it open indefinitely", async () => {
      const destroyMock = vi.fn(() => Promise.resolve());
      const renderMock = vi.fn(() => ({ promise: Promise.resolve() }));
      vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF_BYTES, { status: 200 })));
      mockPdfjs({
        getDocument: vi.fn(() => ({
          destroy: destroyMock,
          promise: Promise.resolve({
            getPage: vi.fn(async () => ({
              getViewport: () => ({ width: 100, height: 140 }),
              render: renderMock,
            })),
          }),
        })),
      });

      render(
        <PdfThumbnail blobId="b1" name="report.pdf" type="application/pdf" fallback={<span>fallback-icon</span>} />,
      );

      await waitFor(() => expect(renderMock).toHaveBeenCalled());
      await waitFor(() => expect(destroyMock).toHaveBeenCalled());
    });

    it("destroys the loading task on unmount if the attachment changes before rendering completes", async () => {
      const destroyMock = vi.fn(() => Promise.resolve());
      let resolveGetPage: (() => void) | undefined;
      const getPagePromise = new Promise((resolve) => {
        resolveGetPage = () => resolve({
          getViewport: () => ({ width: 100, height: 140 }),
          render: vi.fn(() => ({ promise: Promise.resolve() })),
        });
      });
      const getPageMock = vi.fn(() => getPagePromise);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF_BYTES, { status: 200 })));
      mockPdfjs({
        getDocument: vi.fn(() => ({
          destroy: destroyMock,
          promise: Promise.resolve({
            getPage: getPageMock,
          }),
        })),
      });

      const { unmount } = render(
        <PdfThumbnail blobId="b1" name="report.pdf" type="application/pdf" fallback={<span>fallback-icon</span>} />,
      );

      // Wait until the document has resolved and the component has moved on
      // to (still-pending) getPage — by this point the loading task is
      // already held via the component's ref, so unmounting now must
      // destroy it rather than leaking it.
      await waitFor(() => expect(getPageMock).toHaveBeenCalled());
      expect(destroyMock).not.toHaveBeenCalled();
      unmount();

      expect(destroyMock).toHaveBeenCalledTimes(1);

      // Let the stale getPage settle after teardown — must not throw or
      // double-destroy.
      resolveGetPage?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(destroyMock).toHaveBeenCalledTimes(1);
    });
  });
});
