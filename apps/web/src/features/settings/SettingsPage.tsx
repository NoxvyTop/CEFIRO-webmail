import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { FilterSettings } from "./FilterSettings";
import { SignatureSettings } from "./SignatureSettings";
import { VacationSettings } from "./VacationSettings";

type Section = "signatures" | "filters" | "vacation";

const NAV_ITEMS: { id: Section; labelKey: string }[] = [
  { id: "signatures", labelKey: "settings.nav.signatures" },
  { id: "filters", labelKey: "settings.nav.filters" },
  { id: "vacation", labelKey: "settings.nav.vacation" },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("signatures");

  return (
    <main role="main" className="mx-auto flex min-h-full max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
        <Link to="/" className="text-sm text-accent-text underline">
          {t("settings.back")}
        </Link>
      </div>

      <div className="flex flex-1 flex-col gap-6 md:flex-row md:items-start">
        <nav
          aria-label={t("settings.nav.label")}
          className="flex w-full shrink-0 flex-row gap-1 rounded-[14px] border border-line bg-panel p-3 md:w-[184px] md:flex-col"
        >
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
              className={`rounded-[10px] px-3 py-2 text-left text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-accent ${
                section === item.id ? "bg-sel text-accent-text" : "text-ink hover:bg-hover"
              }`}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {section === "signatures" && (
            <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
              <h2 className="text-lg font-medium">{t("settings.signatures")}</h2>
              <SignatureSettings />
            </section>
          )}

          {section === "filters" && (
            <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
              <h2 className="text-lg font-medium">{t("filters.title")}</h2>
              <FilterSettings />
            </section>
          )}

          {section === "vacation" && (
            <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
              <h2 className="text-lg font-medium">{t("vacation.title")}</h2>
              <VacationSettings />
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
