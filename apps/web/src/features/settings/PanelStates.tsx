import { useTranslation } from "react-i18next";
import { CefiroLoader } from "../../app/ui/CefiroLoader";
import { settingsErrorKey } from "./errors";

/**
 * The shared non-content states for the settings panels: loading and
 * load-failed (GH #250), save-failed (GH #148), and unsupported-here (GH #36).
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

interface SettingsUnavailableProps {
  /** Message key explaining what this particular panel cannot do here. */
  messageKey: string;
}

/**
 * Unsupported state (GH #36): the panel's feature does not exist on this
 * account's mail server, so there is nothing to load, retry or save.
 *
 * Deliberately not an error. Neutral rather than danger-coloured, and it
 * replaces the editor instead of sitting above it — an editor whose every save
 * is bound to fail is the thing this exists to remove, and a red alert would
 * suggest something went wrong and could be tried again.
 */
export function SettingsUnavailable({ messageKey }: SettingsUnavailableProps) {
  const { t } = useTranslation();

  return (
    <p data-testid="settings-unavailable" className="text-sm text-muted">
      {t(messageKey)}
    </p>
  );
}

interface SettingsMutationErrorProps {
  /** The mutation's error, resolved through the shared settings code → message map. */
  error: unknown;
}

/**
 * Failed WRITE state (GH #148), the other half of the pair #250 started.
 *
 * A failed load replaces the panel and offers a retry; a failed save leaves the
 * panel — and the user's unsaved input — exactly where it was, so there is
 * nothing to refetch and the retry affordance is the save button they already
 * pressed. What was missing is any sign that it failed at all: without this,
 * SignatureSettings answered a failed create/edit/delete with no `role="alert"`
 * and no visible change, so a save that never happened looked identical to one
 * that did.
 *
 * `role="alert"` and the same danger colour as SettingsLoadError, in the plain
 * inline shape ProfileSettings, VacationSettings and ContactsSettings already
 * use for the same event — a save failure is not panel-level chrome.
 */
export function SettingsMutationError({ error }: SettingsMutationErrorProps) {
  const { t } = useTranslation();

  return (
    <p role="alert" className="text-sm text-danger">
      {t(settingsErrorKey(error))}
    </p>
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
