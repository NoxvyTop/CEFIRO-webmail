import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UserMenu } from "./UserMenu";
import { useToast } from "./toast";
import { browserNotificationPermission } from "../../features/notifications/NotificationSettings";

// GH #337 (b): the profile menu's notification opt-in, with the outcome the
// original never showed.
//
// It is a component of its own rather than three more lines inside App because
// the toast is only reachable from INSIDE ToastProvider, and App is what
// renders that provider — a `useToast()` call in App would throw. Splitting the
// menu out puts the hook where the context actually exists, and keeps the
// permission state next to the only thing that changes it.

interface AppUserMenuProps {
  user: { email: string; displayName?: string | null; role?: string };
  avatarUrl?: string | null;
  theme: "night" | "light";
  onToggleTheme: () => void;
  onLogout: () => void;
  onShowShortcuts: () => void;
}

export function AppUserMenu({
  user,
  avatarUrl,
  theme,
  onToggleTheme,
  onLogout,
  onShowShortcuts,
}: AppUserMenuProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [permission, setPermission] = useState<NotificationPermission | null>(
    browserNotificationPermission,
  );

  async function handleEnableNotifications() {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setPermission(result);
    // The answer is the whole point: a granted permission is otherwise
    // invisible until mail happens to arrive, and a denied one looked exactly
    // like a click that did nothing.
    showToast(
      result === "granted"
        ? t("notifications.browser.granted")
        : t("notifications.browser.denied"),
    );
  }

  return (
    <UserMenu
      user={user}
      avatarUrl={avatarUrl}
      theme={theme}
      onToggleTheme={onToggleTheme}
      onLogout={onLogout}
      notificationPermission={permission}
      onEnableNotifications={() => void handleEnableNotifications()}
      onShowShortcuts={onShowShortcuts}
    />
  );
}
