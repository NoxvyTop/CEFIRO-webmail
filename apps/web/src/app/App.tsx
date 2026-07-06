import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { healthResponseSchema } from "@webmail/shared";

async function fetchHealth() {
  const res = await fetch("/api/health");
  return healthResponseSchema.parse(await res.json());
}

export function App() {
  const { t } = useTranslation();
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-semibold">{t("app.title")}</h1>
      {health.data && (
        <p className="text-sm text-gray-500">
          {t(health.data.status === "ok" ? "health.ok" : "health.degraded")}
        </p>
      )}
    </main>
  );
}
