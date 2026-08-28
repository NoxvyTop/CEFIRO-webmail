import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import { healthResponseSchema } from "@webmail/shared";
import { useAuth } from "../features/auth/useAuth";
import { useProfile } from "../features/settings/useProfile";
import { CefiroLoader } from "./ui/CefiroLoader";
import { CefiroLogo } from "./ui/CefiroLogo";
import { ShortcutsOverlay } from "./ui/ShortcutsOverlay";
import { isPlainShortcut } from "./ui/shortcuts";
import { ToastProvider } from "./ui/toast";
import { AppUserMenu } from "./ui/AppUserMenu";
import { useOnlineStatus } from "./ui/useOnlineStatus";
import { useTheme } from "./ui/useTheme";

async function fetchHealth() {
  const res = await fetch("/api/health");
  return healthResponseSchema.parse(await res.json());
}

export function App() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const profile = useProfile();
  const { theme, toggleTheme } = useTheme();
  // GH #345: there was no offline signal anywhere in the UI — a lost
  // connection looked identical to a slow one until every in-flight request
  // failed on its own.
  const online = useOnlineStatus();
  // GH #342: used to run exactly once (on mount), so a backend that degraded
  // mid-session never surfaced "Servicio degradado" — the banner only ever
  // reflected the state at page load. Polling lets it appear at any point in
  // an open session, not just after a fresh navigation.
  const health = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 60_000,
  });
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryParam = searchParams.get("q") ?? "";
  const [searchValue, setSearchValue] = useState(queryParam);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSearchValue(queryParam);
  }, [queryParam]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!isPlainShortcut(event)) return;
      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (event.key === "?") {
        event.preventDefault();
        setShowShortcuts((current) => !current);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = searchValue.trim();
    if (location.pathname !== "/") {
      navigate(trimmed ? `/?q=${encodeURIComponent(trimmed)}` : "/");
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (trimmed) {
        next.set("q", trimmed);
      } else {
        next.delete("q");
      }
      next.delete("thread");
      return next;
    });
  }

  // MailPage (the "/" route) renders no landmark of its own, so the shell
  // supplies the <main> for it. Settings/Admin already wrap their content in
  // their own <main>, so here the shell must NOT add a second one (a nested
  // <main> is invalid and confuses landmark navigation) — it renders a plain
  // wrapper that still carries the skip-link target id.
  const shellOwnsMainLandmark = location.pathname === "/";
  const outletRegion = (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center p-10">
          <CefiroLoader label />
        </div>
      }
    >
      <Outlet />
    </Suspense>
  );

  return (
    <ToastProvider>
      {/* #348: h-screen resolves against iOS Safari's LARGE viewport, which
          includes the area the address/toolbar chrome covers before it
          collapses on scroll — h-dvh tracks the dynamic viewport instead, so
          the shell isn't taller than what's actually visible on first paint. */}
      <div className="flex h-dvh flex-col">
        <a
          href="#main-content"
          className="sr-only left-4 top-4 z-50 rounded-md bg-accent px-4 py-2 text-sm font-bold text-accent-ink shadow-cta focus:not-sr-only focus:absolute"
        >
          {t("app.skipToContent")}
        </a>
        {/* no overflow clipping here: it would cut off the absolutely-positioned user menu */}
        {/* GH #293: paint into the status-bar safe area on notched phones/PWA
            (viewport-fit=cover in index.html opts the viewport in). min-h keeps
            the 60px bar on desktop, where env(safe-area-inset-top) resolves to
            0, and lets it grow by the inset rather than squeezing its content. */}
        <header className="flex min-h-[60px] shrink-0 items-center gap-5 border-b border-line bg-panel px-5 pt-[env(safe-area-inset-top)] text-ink">
          <Link
            to="/"
            aria-label={t("app.home")}
            className="flex shrink-0 items-center justify-center gap-[11px] rounded-md transition hover:opacity-80 md:min-w-[210px]"
          >
            <CefiroLogo size={32} />
            <span className="hidden text-[15px] font-bold tracking-[0.32em] md:block">CÉFIRO</span>
          </Link>
          <form onSubmit={handleSearchSubmit} className="min-w-0 max-w-[560px] flex-1">
            <div className="field-focus-within flex h-10 items-center gap-2.5 rounded-input border border-line bg-soft px-3.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="shrink-0 opacity-50">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                ref={searchInputRef}
                type="search"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder={t("mail.searchPlaceholder")}
                aria-label={t("mail.searchPlaceholder")}
                className="w-full bg-transparent text-sm text-ink field-focus-line placeholder:text-muted"
              />
              <kbd aria-hidden="true" className="rounded-[5px] border border-line bg-panel px-[7px] py-[2px] text-[11px] text-muted">/</kbd>
            </div>
          </form>
          {health.data && health.data.status !== "ok" && (
            <p className="text-sm text-warn">{t("health.degraded")}</p>
          )}
          {user && (
            <div className="ml-auto flex shrink-0 items-center gap-3">
              {/* GH #13/#50 (G-4): the shared-mailbox selector and the standalone
                  "Atajos" button both left the header — accounts now switch from
                  the "Buzones compartidos" page (left sidebar), and "Atajos"
                  moved into the profile menu below. The `?`/Escape handlers stay
                  wired regardless. */}
              {/* GH #337 (b): the notification opt-in moved into AppUserMenu,
                  which lives inside ToastProvider and can therefore report what
                  the browser answered. */}
              <AppUserMenu
                user={user}
                avatarUrl={profile.data?.avatarDataUrl}
                theme={theme}
                onToggleTheme={toggleTheme}
                onLogout={() => void logout()}
                onShowShortcuts={() => setShowShortcuts(true)}
              />
            </div>
          )}
        </header>
        {/* GH #345: persistent (not a toast) — the condition lasts until the
            connection actually returns, and a toast fading out would read
            as "resolved" while still offline. */}
        {!online && (
          <p
            role="status"
            className="shrink-0 border-b border-line bg-soft px-4 py-2 text-center text-xs text-warn"
          >
            {t("app.offline")}
          </p>
        )}
        {shellOwnsMainLandmark ? (
          <main id="main-content" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {outletRegion}
          </main>
        ) : (
          <div id="main-content" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {outletRegion}
          </div>
        )}
        <ShortcutsOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      </div>
    </ToastProvider>
  );
}
