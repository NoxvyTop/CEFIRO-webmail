import { useTranslation } from "react-i18next";
import { CefiroLoader } from "../../app/ui/CefiroLoader";
import { settingsErrorKey } from "./errors";

/**
 * GH #250: the shared loading and load-failed states for the query-backed
 * settings panels.
 *
 * Before this, SignatureSettings and ContactsSettings both did
 * `if (!query.data) return null`, and FilterSettings gated its empty state on
 * `isLoading` alone — so a failed load rendered either a blank panel or, worse,
 * the "no rules yet" copy, which tells the user their configuration is gone
 * when it is only unreachable. Every panel now has to pick one of three
 * distinct states, and the failed one always carries a way back.
 */

/** Pending state: the query has neither data nor an error yet. */
export function SettingsLoading() {
  return (
    <div data-testid="settings-loading" className="flex justify-center p-4">
      <CefiroLoader />
    </div>
  );
}

interface SettingsLoadErrorProps {
  /** The query's error, resolved through the shared settings code → message map. */
  error: unknown;
  /** Refetches the panel's query. Wired to the retry button. */
  onRetry: () => void;
}

/**
 * Failed state. `role="alert"` because it replaces content the user asked for
 * and was not given — matching how FilterSettings already announces a failed
 * mutation — and the retry button is part of the message rather than a
 * separate affordance the user has to go looking for.
 */
export function SettingsLoadError({ error, onRetry }: SettingsLoadErrorProps) {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/40 bg-soft p-2 text-sm text-danger"
    >
      <span>{t(settingsErrorKey(error))}</span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-danger/40 px-2 py-1 text-xs hover:bg-hover"
      >
        {t("settings.retry")}
      </button>
    </div>
  );
}
