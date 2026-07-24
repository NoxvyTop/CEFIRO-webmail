import { useTranslation } from "react-i18next";
import { CefiroLogo } from "./CefiroLogo";

// GH #94: branded loading indicator. Mounts ON TOP of pending states that
// already exist elsewhere (React Query isLoading/isPending in ThreadView,
// the pdf.js loading `fallback` in PdfThumbnail) — it never owns any data
// flow itself, just renders while the caller says something is loading.
//
// The spin is a much faster pace than CefiroLogo's own default ambient 28s
// ring (see CefiroLogo's spinSeconds prop) — a "working" cue instead of a
// slow idle animation. It's CSS-only (a plain @keyframes animation via
// inline style, same mechanism as the ambient spin), so the app's existing
// global `@media (prefers-reduced-motion: reduce)` rule (theme.css) already
// zeroes it out — no separate reduced-motion handling needed here.
const LOADING_SPIN_SECONDS = 1.2;
const DEFAULT_SIZE = 40;

interface CefiroLoaderProps {
  /** Logo size in px. Defaults to a small, unobtrusive size. */
  size?: number;
  /**
   * Shows a visible "Cargando…" label below the mark. Off by default, for
   * compact placements (e.g. inside a small attachment card) where a caption
   * would be cramped — the loading state is still announced to screen
   * readers either way via the status role's accessible name.
   */
  label?: boolean;
}

export function CefiroLoader({ size = DEFAULT_SIZE, label = false }: CefiroLoaderProps) {
  const { t } = useTranslation();
  const loadingText = t("mail.loading");

  return (
    <div role="status" aria-label={loadingText} className="flex flex-col items-center justify-center gap-2">
      <CefiroLogo size={size} spinSeconds={LOADING_SPIN_SECONDS} />
      {label && <span className="text-[13px] font-medium text-muted">{loadingText}</span>}
    </div>
  );
}
