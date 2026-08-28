import { Component, type ReactNode } from "react";
import i18n from "./i18n";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

/**
 * GH #345: routes.tsx's `errorElement` (see RouteError.tsx) only catches
 * errors thrown while react-router renders a matched route — nothing thrown
 * OUTSIDE that tree (during RouterProvider's own render, or before a route
 * even matches) was ever caught, and main.tsx had no boundary of its own.
 *
 * Deliberately minimal: a class component (the only way to catch a render
 * error in React) whose one job is to catch and offer the one available
 * recovery action. It does not attempt routeErrorClassifier's chunk-load
 * detection — bundle/chunk loading only happens inside routes, which
 * RouteError already covers; anything reaching this boundary is by
 * definition something else.
 *
 * Uses the `i18n` singleton directly rather than `useTranslation` because a
 * class component has no hooks; this is the same instance react-i18next's
 * `initReactI18next` wires up in main.tsx, so it renders in whatever
 * language is already active.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error("[AppErrorBoundary] caught an error outside the router tree:", error);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center text-muted">
        <p role="alert" className="text-[15px] font-semibold text-ink">
          {i18n.t("app.routeError.genericTitle")}
        </p>
        <p className="max-w-[360px] text-[13px] text-muted">
          {i18n.t("app.routeError.genericDescription")}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-1 flex h-9 items-center justify-center rounded-[10px] bg-accent px-4 text-[13px] font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
        >
          {i18n.t("app.routeError.reload")}
        </button>
      </div>
    );
  }
}
