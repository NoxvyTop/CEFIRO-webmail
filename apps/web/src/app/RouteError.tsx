import { useTranslation } from "react-i18next";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { isChunkLoadFailure } from "./routeErrorClassifier";

/**
 * GH #345: routes.tsx wires this in as every top-level route's
 * `errorElement`. Before this, routes had none at all, so a rejected lazy
 * import (a stale hashed chunk 404 after a deploy — Composer, Settings,
 * pdfjs) fell straight through to react-router's built-in "Unexpected
 * Application Error!" page: English-only, off-brand, and giving no hint that
 * a reload would fix it.
 *
 * A chunk-load failure gets a specific "a new version is available, reload"
 * message, since that is both diagnosable (see routeErrorClassifier) and has
 * one guaranteed fix. Anything else gets a generic fallback with the same
 * one recovery action — this component does not try to distinguish further
 * causes, only to never leave the user on a dead screen.
 */
export function RouteError() {
  const { t } = useTranslation();
  const error = useRouteError();
  const chunkLoadFailure = !isRouteErrorResponse(error) && isChunkLoadFailure(error);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center text-muted">
      <p role="alert" className="text-[15px] font-semibold text-ink">
        {t(chunkLoadFailure ? "app.routeError.staleTitle" : "app.routeError.genericTitle")}
      </p>
      <p className="max-w-[360px] text-[13px] text-muted">
        {t(chunkLoadFailure ? "app.routeError.staleDescription" : "app.routeError.genericDescription")}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-1 flex h-9 items-center justify-center rounded-[10px] bg-accent px-4 text-[13px] font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
      >
        {t("app.routeError.reload")}
      </button>
    </div>
  );
}
