import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { healthResponseSchema } from "@webmail/shared";
import { useAuth } from "../features/auth/useAuth";
import { CefiroLogo } from "./ui/CefiroLogo";
import { ShortcutsOverlay } from "./ui/ShortcutsOverlay";
import { isPlainShortcut } from "./ui/shortcuts";
import { ToastProvider } from "./ui/toast";
import { UserMenu } from "./ui/UserMenu";
import { useTheme } from "./ui/useTheme";

async function fetchHealth() {
  const res = await fetch("/api/health");
  return healthResponseSchema.parse(await res.json());
}

function currentNotificationPermission(): NotificationPermission | null {
  return typeof Notification === "undefined" ? null : Notification.permission;
}

export function App() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryParam = searchParams.get("q") ?? "";
  const [searchValue, setSearchValue] = useState(queryParam);
  const [notificationPermission, setNotificationPermission] = useState(currentNotificationPermission);
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

  async function handleEnableNotifications() {
    if (typeof Notification === "undefined") return;
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
  }

  return (
    <ToastProvider>
      <div className="flex h-screen flex-col">
        {/* no overflow clipping here: it would cut off the absolutely-positioned user menu */}
        <header className="flex h-[60px] shrink-0 items-center gap-5 border-b border-line bg-panel px-5 text-ink">
          <div className="flex shrink-0 items-center gap-[11px] md:min-w-[210px]">
            <CefiroLogo size={32} />
            <div className="hidden flex-col md:flex">
              <span className="text-[15px] font-bold tracking-[0.32em]">CÉFIRO</span>
              <span className="text-[10.5px] tracking-[0.08em] text-muted">{t("app.tagline")}</span>
            </div>
          </div>
          <form onSubmit={handleSearchSubmit} className="min-w-0 max-w-[560px] flex-1">
            <div className="flex h-10 items-center gap-2.5 rounded-input border border-line bg-soft px-3.5">
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
                className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted"
              />
              <kbd aria-hidden="true" className="rounded-[5px] border border-line bg-panel px-[7px] py-[2px] text-[11px] text-muted">/</kbd>
            </div>
          </form>
          {health.data && health.data.status !== "ok" && (
            <p className="text-sm text-warn">{t("health.degraded")}</p>
          )}
          {user && (
            <div className="ml-auto flex shrink-0 items-center gap-3">
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => setShowShortcuts((current) => !current)}
                className="flex h-[34px] shrink-0 items-center gap-[7px] rounded-[8px] border border-line px-3 text-[13px] text-muted transition hover:bg-hover hover:text-ink"
              >
                <kbd aria-hidden="true" className="rounded border border-line px-[6px] py-[1px] text-[11px]">?</kbd>
                {t("shortcuts.title")}
              </button>
              <UserMenu
                user={user}
                theme={theme}
                onToggleTheme={toggleTheme}
                onLogout={() => void logout()}
                showNotifications={notificationPermission === "default"}
                onEnableNotifications={() => void handleEnableNotifications()}
              />
            </div>
          )}
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Outlet />
        </div>
        <ShortcutsOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      </div>
    </ToastProvider>
  );
}
