import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PushSettings } from "./PushSettings";

// GH #337 (b): one "Notificaciones" section instead of two disconnected places.
//
// Before this, the in-tab alert was a single "Activar notificaciones" item in
// the profile menu — a bare `Notification.requestPermission()` that showed no
// result, offered no way back, and was unrelated to the push panel in Settings.
// Both halves of the same question ("may Céfiro alert me, and where?") now sit
// together: the browser permission that covers the open tab, and the
// background push that covers the closed app.

/**
 * The browser's current Notification permission, or null when the API does not
 * exist at all (an old browser, a non-secure context, jsdom without a stub).
 * Read at render rather than cached in a module: it changes from outside React
 * (browser settings, another tab) and this component is short-lived.
 */
export function browserNotificationPermission(): NotificationPermission | null {
  return typeof Notification === "undefined" ? null : Notification.permission;
}

/** The in-tab half: the browser permission, its state, and the one way to ask. */
function BrowserAlerts() {
  const { t } = useTranslation();
  const [permission, setPermission] = useState<NotificationPermission | null>(
    browserNotificationPermission,
  );

  async function handleRequest() {
    if (typeof Notification === "undefined") return;
    // Only ever from this click: asking on load is what browsers penalise, and
    // what the design doc forbids.
    setPermission(await Notification.requestPermission());
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink">{t("notifications.browser.title")}</h3>
      <p className="text-sm text-muted">{t("notifications.browser.description")}</p>
      {permission === null ? (
        <p className="text-sm text-muted">{t("notifications.browser.unsupported")}</p>
      ) : permission === "granted" ? (
        <p className="text-sm text-ink">{t("notifications.browser.granted")}</p>
      ) : permission === "denied" ? (
        // No button: once denied, requestPermission resolves "denied" without
        // ever prompting again, so offering it would be a control that cannot
        // work. The way back is the browser's own settings.
        <p className="text-sm text-muted">{t("notifications.browser.denied")}</p>
      ) : (
        <button
          type="button"
          onClick={() => void handleRequest()}
          className="self-start rounded-[11px] border border-line px-3 py-1 text-sm font-semibold text-ink transition hover:bg-hover"
        >
          {t("notifications.browser.enable")}
        </button>
      )}
    </div>
  );
}

export function NotificationSettings() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      <BrowserAlerts />
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink">{t("notifications.pushTitle")}</h3>
        <PushSettings />
      </div>
    </div>
  );
}
