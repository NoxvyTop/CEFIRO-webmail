import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { FilterSettings } from "./FilterSettings";
import { SignatureSettings } from "./SignatureSettings";
import { VacationSettings } from "./VacationSettings";

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

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t("filters.title")}</h2>
        <FilterSettings />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t("vacation.title")}</h2>
        <VacationSettings />
      </section>
    </main>
  );
}
