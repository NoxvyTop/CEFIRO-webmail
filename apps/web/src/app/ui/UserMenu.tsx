import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Avatar } from "./Avatar";
import { BellIcon, LogoutIcon, MoonIcon, SettingsIcon, SunIcon, UsersIcon } from "./icons";

interface UserMenuUser {
  email: string;
  displayName?: string | null;
  role?: string;
}

interface UserMenuProps {
  user: UserMenuUser;
  theme: "night" | "light";
  onToggleTheme: () => void;
  onLogout: () => void;
  showNotifications: boolean;
  onEnableNotifications: () => void;
}

const menuItemClass =
  "flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-ink hover:bg-hover";

export function UserMenu({
  user,
  theme,
  onToggleTheme,
  onLogout,
  showNotifications,
  onEnableNotifications,
}: UserMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
        <Avatar name={user.displayName ?? null} email={user.email} size={36} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 flex min-w-[230px] flex-col rounded-[12px] border border-line bg-panel py-1 shadow-[0_24px_70px_rgba(0,0,0,0.5)]"
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
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={onToggleTheme}
          >
            {theme === "night" ? <SunIcon /> : <MoonIcon />}
            {t(theme === "night" ? "app.themeLight" : "app.themeNight")}
          </button>
          {showNotifications && (
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={onEnableNotifications}
            >
              <BellIcon />
              {t("mail.enableNotifications")}
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
