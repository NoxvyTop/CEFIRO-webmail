import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { healthResponseSchema } from "@webmail/shared";
import { useAuth } from "../features/auth/useAuth";
import { MailPage } from "../features/mailbox/MailPage";

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
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });
  const [searchParams, setSearchParams] = useSearchParams();
  const queryParam = searchParams.get("q") ?? "";
  const [searchValue, setSearchValue] = useState(queryParam);
  const [notificationPermission, setNotificationPermission] = useState(currentNotificationPermission);

  useEffect(() => {
    setSearchValue(queryParam);
  }, [queryParam]);

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const trimmed = searchValue.trim();
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
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">{t("app.title")}</h1>
        <form onSubmit={handleSearchSubmit} className="flex-1">
          <input
            type="search"
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            placeholder={t("mail.searchPlaceholder")}
            aria-label={t("mail.searchPlaceholder")}
            className="w-full rounded-md border px-3 py-1 text-sm"
          />
        </form>
        {notificationPermission === "default" && (
          <button
            type="button"
            onClick={() => void handleEnableNotifications()}
            aria-label={t("mail.enableNotifications")}
            className="rounded-md border px-2 py-1 text-sm"
          >
            🔔
          </button>
        )}
        {user && (
          <p className="text-sm text-gray-600">
            {t("auth.signedInAs", { email: user.email })}
          </p>
        )}
        {health.data && (
          <p className="text-sm text-gray-500">
            {t(health.data.status === "ok" ? "health.ok" : "health.degraded")}
          </p>
        )}
        <button
          type="button"
          onClick={() => void logout()}
          className="rounded-md border px-3 py-1 text-sm"
        >
          {t("auth.signOut")}
        </button>
      </header>
      <MailPage />
    </div>
  );
}
