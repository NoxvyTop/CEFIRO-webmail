import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Avatar } from "./Avatar";
import { BellIcon, KeyboardIcon, LogoutIcon, MoonIcon, SettingsIcon, SunIcon, UsersIcon } from "./icons";
import { useMenuKeyboardNav } from "./useMenuKeyboardNav";

interface UserMenuUser {
  email: string;
  displayName?: string | null;
  role?: string;
}

interface UserMenuProps {
  user: UserMenuUser;
  // Profile photo (data: URL), fetched separately from /api/profile — see
  // useProfile in features/settings. Absent/null keeps the initials fallback.
  avatarUrl?: string | null;
  theme: "night" | "light";
  onToggleTheme: () => void;
  onLogout: () => void;
  // GH #337 (b): the browser's own Notification permission, or null when the
  // API does not exist. It replaces the `showNotifications` boolean because the
  // item has three states, not two: askable, blocked (visible but inert, so a
  // user who once said no is not left wondering where the alerts went), and
  // done. The boolean could only ever express the first.
  notificationPermission: NotificationPermission | null;
  onEnableNotifications: () => void;
  // GH #13/#50 (G-4): opens the keyboard-shortcuts dialog. The standalone
  // "Atajos" header button moved in here; the `?` keyboard trigger is unchanged.
  onShowShortcuts: () => void;
}

const menuItemClass =
  "flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-ink hover:bg-hover";

export function UserMenu({
  user,
  avatarUrl,
  theme,
  onToggleTheme,
  onLogout,
  notificationPermission,
  onEnableNotifications,
  onShowShortcuts,
}: UserMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // #348: WAI-ARIA menu keyboard behavior — focus the first item on open,
  // ArrowUp/ArrowDown/Home/End move between items.
  const menuRef = useMenuKeyboardNav<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label={t("auth.signedInAs", { email: user.email })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.email}
      >
        <Avatar
          name={user.displayName ?? null}
          email={user.email}
          size={36}
          tone="accent"
          imageUrl={avatarUrl}
        />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 flex min-w-[230px] flex-col rounded-[12px] border border-line bg-panel py-1 shadow-pop"
        >
          <div className="px-3 py-2">
            {user.displayName && <div className="font-semibold">{user.displayName}</div>}
            <div className="truncate text-xs text-muted">{user.email}</div>
          </div>
          <div className="my-1 border-t border-line" />
          <Link to="/settings" role="menuitem" className={menuItemClass} onClick={() => setOpen(false)}>
            <SettingsIcon />
            {t("settings.title")}
          </Link>
          {user.role === "admin" && (
            <Link to="/admin" role="menuitem" className={menuItemClass} onClick={() => setOpen(false)}>
              <UsersIcon />
              {t("admin.title")}
            </Link>
          )}
          {/* GH #13/#50 (G-4): the "Atajos" launcher moved here from a standalone
              header button; it opens the same shortcuts dialog. */}
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={() => {
              onShowShortcuts();
              setOpen(false);
            }}
          >
            <KeyboardIcon />
            {t("shortcuts.title")}
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={onToggleTheme}
          >
            {theme === "night" ? <SunIcon /> : <MoonIcon />}
            {t(theme === "night" ? "app.themeLight" : "app.themeNight")}
          </button>
          {(notificationPermission === "default" || notificationPermission === "denied") && (
            <button
              type="button"
              role="menuitem"
              className={`${menuItemClass} disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent`}
              // Blocked is shown, not offered: requestPermission resolves
              // "denied" without ever prompting again, so a live button would
              // be a control that cannot work. Settings > Notificaciones says
              // how to undo it.
              disabled={notificationPermission === "denied"}
              onClick={onEnableNotifications}
            >
              <BellIcon />
              {notificationPermission === "denied"
                ? t("mail.notificationsBlocked")
                : t("mail.enableNotifications")}
            </button>
          )}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={onLogout}
          >
            <LogoutIcon />
            {t("auth.signOut")}
          </button>
        </div>
      )}
    </div>
  );
}
