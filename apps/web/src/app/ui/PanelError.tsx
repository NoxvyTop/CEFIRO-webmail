import { useTranslation } from "react-i18next";

interface PanelErrorProps {
  /** Already-resolved, translated error message. */
  message: string;
  /** Refetches the query that failed. Wired to the retry button. */
  onRetry: () => void;
}

/**
 * GH #345: the shared panel-level failed-load state (message + retry),
 * modeled on settings/PanelStates.tsx's SettingsLoadError (GH #250). Before
 * this, MailPage's mailbox list, MessageList's message list and ThreadView's
 * reader each rendered a bare `<p role="alert">` with no way back into the
 * query that failed — a transient upstream error (a JMAP provider restart)
 * left "No se pudo cargar el correo" on screen until the next unrelated
 * refetch happened to succeed.
 *
 * `role="alert"` because it replaces content the user asked for and was not
 * given, matching SettingsLoadError; the retry button is part of the message
 * rather than a separate affordance the user has to go looking for.
 */
export function PanelError({ message, onRetry }: PanelErrorProps) {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm text-warn"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-md border border-warn/40 px-2 py-1 text-xs hover:bg-hover"
      >
        {t("settings.retry")}
      </button>
    </div>
  );
}
