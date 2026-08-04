import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ContactsSettings } from "./ContactsSettings";
import { FilterSettings } from "./FilterSettings";
import { ProfileSettings } from "./ProfileSettings";
import { SessionsSettings } from "./SessionsSettings";
import { SharedMailboxesSettings } from "./SharedMailboxesSettings";
import { SignatureSettings } from "./SignatureSettings";
import { VacationSettings } from "./VacationSettings";
import { PushSettings, PUSH_STATUS_QUERY_KEY } from "../notifications/PushSettings";
import { fetchPushStatus } from "../notifications/pushApi";

type Section =
  | "profile"
  | "signatures"
  | "filters"
  | "vacation"
  | "contacts"
  | "sharedMailboxes"
  | "sessions"
  | "notifications";

const NAV_ITEMS: { id: Section; labelKey: string }[] = [
  { id: "profile", labelKey: "settings.nav.profile" },
  { id: "signatures", labelKey: "settings.nav.signatures" },
  { id: "filters", labelKey: "settings.nav.filters" },
  { id: "vacation", labelKey: "settings.nav.vacation" },
  { id: "contacts", labelKey: "settings.nav.contacts" },
  // GH #13/#50: shared mailboxes the member can enter, plus the copy opt-in.
  // Always shown; the panel itself renders a friendly empty state for the
  // common case of a member with no shared mailboxes.
  { id: "sharedMailboxes", labelKey: "settings.nav.sharedMailboxes" },
  // #302: active sessions / devices with individual revocation. Always shown —
  // every user has at least their current session.
  { id: "sessions", labelKey: "settings.nav.sessions" },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("profile");
  // #294: the Notifications section is offered only when push is enabled on the
  // server — the same /push/status gate the panel itself checks, hidden here so
  // the nav entry never appears when the feature is off (the default).
  const pushStatus = useQuery({ queryKey: PUSH_STATUS_QUERY_KEY, queryFn: fetchPushStatus });
  const navItems = pushStatus.data
    ? [...NAV_ITEMS, { id: "notifications" as const, labelKey: "settings.nav.notifications" }]
    : NAV_ITEMS;

  return (
    // GH #253: no role="main" — <main> already has it, and spelling it out
    // again is the kind of redundant ARIA that hides real findings in the lint
    // report. The landmark itself (#200) is unchanged.
    <main className="flex min-h-full flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
        <Link to="/" className="text-sm text-accent-text underline">
          {t("settings.back")}
        </Link>
      </div>

      <div className="flex flex-1 flex-col gap-6 md:flex-row md:items-start">
        {/* GH #226: below md this is a single horizontal row, and the five
            Spanish tabs ("Vacaciones", "Contactos", …) want ~440px — more than
            a 375px phone has — with nothing to wrap or scroll them back into
            reach. It wraps onto as many lines as it needs instead of
            scrolling: the nav has no fixed height to preserve, and a wrapped
            row leaves every tab visible rather than hiding some behind an
            overlay scrollbar nothing hints at. From md up the nav is a column
            again, where wrapping has nothing to do. */}
        <nav
          aria-label={t("settings.nav.label")}
          className="flex w-full shrink-0 flex-row flex-wrap gap-1 rounded-[14px] border border-line bg-panel p-3 md:w-[184px] md:flex-col md:flex-nowrap"
        >
          {navItems.map((item) => (
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
          {section === "profile" && (
            <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
              <h2 className="text-lg font-medium">{t("settings.profile")}</h2>
              <ProfileSettings />
            </section>
          )}

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

          {section === "contacts" && (
            <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
              <h2 className="text-lg font-medium">{t("contacts.title")}</h2>
              <ContactsSettings />
            </section>
          )}

          {section === "sharedMailboxes" && (
            <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
              <h2 className="text-lg font-medium">{t("sharedMailboxes.title")}</h2>
              <SharedMailboxesSettings />
            </section>
          )}

          {section === "sessions" && (
            <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
              <h2 className="text-lg font-medium">{t("settings.sessions.title")}</h2>
              <SessionsSettings />
            </section>
          )}

          {section === "notifications" && (
            <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
              <h2 className="text-lg font-medium">{t("notifications.title")}</h2>
              <PushSettings />
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
