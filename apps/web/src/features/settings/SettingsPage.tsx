import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { SignatureSettings } from "./SignatureSettings";

export function SettingsPage() {
  const { t } = useTranslation();

  return (
    <main role="main" className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
        <Link to="/" className="text-sm text-blue-700 underline">
          {t("settings.back")}
        </Link>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t("settings.signatures")}</h2>
        <SignatureSettings />
      </section>
    </main>
  );
}
