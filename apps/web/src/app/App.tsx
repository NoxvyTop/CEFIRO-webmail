import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { healthResponseSchema } from "@webmail/shared";
import { useAuth } from "../features/auth/useAuth";
import { MailPage } from "../features/mailbox/MailPage";

async function fetchHealth() {
  const res = await fetch("/api/health");
  return healthResponseSchema.parse(await res.json());
}

export function App() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">{t("app.title")}</h1>
        <input
          type="search"
          disabled
          placeholder={t("mail.searchPlaceholder")}
          aria-label={t("mail.searchPlaceholder")}
          className="flex-1 rounded-md border px-3 py-1 text-sm disabled:bg-gray-50"
        />
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
