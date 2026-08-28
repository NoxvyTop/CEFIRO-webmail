import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * True once the returned ref's element has entered the viewport, per
 * IntersectionObserver.
 *
 * #349: PdfThumbnail and AttachmentCard's own `<img>` both did real work —
 * a full blob fetch, and for PdfThumbnail an additional ~1MB pdf.js chunk —
 * the moment they mounted, regardless of whether the card was actually on
 * screen. A thread with 10 attachments meant 10 full downloads firing at
 * once on open. Gating a card's real thumbnail behind this hook instead
 * defers that work until the card is actually about to be seen.
 *
 * One-shot: once true, stays true and the observer disconnects — a
 * thumbnail that has already loaded must not unmount/reload just because
 * the user scrolled it back out of view.
 *
 * Falls back to visible-immediately when IntersectionObserver is
 * unavailable, matching MessageList.tsx's own infinite-scroll sentinel —
 * a missing API degrades to "just render it", never to "never render it".
 */
export function useInViewport<T extends HTMLElement>(
  options?: IntersectionObserverInit,
): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inViewport, setInViewport] = useState(false);

  useEffect(() => {
    if (inViewport) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setInViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setInViewport(true);
      }
    }, options);
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `options` is expected to be a stable reference (or omitted) per caller; re-running per render would thrash the observer for no benefit.
  }, [inViewport]);

  return [ref, inViewport];
}
