import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../app/ui/relative-time";
import { fetchSessions, revokeOtherSessions, revokeSession } from "./api";
import { SettingsLoadError, SettingsLoading, SettingsMutationError } from "./PanelStates";

export const SESSIONS_QUERY_KEY = ["settings", "sessions"];

// A coarse, translation-free device label from a User-Agent. Browser and OS
// names are proper nouns, so no locale is involved; anything we cannot place
// falls back to the caller's own translated "unknown device" copy. Kept
// deliberately shallow — this is a recognition aid for the person reading their
// own logins, not fingerprinting.
function matchOs(userAgent: string): string | null {
  if (/Windows/.test(userAgent)) return "Windows";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}

function matchBrowser(userAgent: string): string | null {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\/|Opera/.test(userAgent)) return "Opera";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return null;
}

export function deviceLabel(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const parts = [matchBrowser(userAgent), matchOs(userAgent)].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function SessionsSettings() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: SESSIONS_QUERY_KEY, queryFn: fetchSessions });

  // #348: closing every other session is a bulk destructive action — mirrors
  // Sidebar.tsx's inline two-step confirm for deleting a label (GH #103)
  // rather than acting on the first click.
  const [confirmingCloseOthers, setConfirmingCloseOthers] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  const revokeOne = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: invalidate,
  });
  const revokeRest = useMutation({
    mutationFn: () => revokeOtherSessions(),
    onSuccess: async () => {
      setConfirmingCloseOthers(false);
      await invalidate();
    },
  });

  // GH #250/#272 language: a failed load replaces the panel with a retry; a
  // failed revoke leaves the list in place and announces itself inline.
  if (query.isError) {
    return <SettingsLoadError error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (!query.data) {
    return <SettingsLoading />;
  }

  const sessions = query.data;
  const otherCount = sessions.filter((session) => !session.current).length;
  const mutationError = revokeOne.error ?? revokeRest.error;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("settings.sessions.description")}</p>

      {mutationError ? <SettingsMutationError error={mutationError} /> : null}

      <ul className="flex flex-col gap-3">
        {sessions.map((session) => (
          <li
            key={session.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-line bg-soft p-4"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                {deviceLabel(session.userAgent) ?? t("settings.sessions.unknownDevice")}
                {session.current && (
                  <span className="rounded-full bg-sel px-2 py-0.5 text-[11px] font-semibold text-accent-text">
                    {t("settings.sessions.current")}
                  </span>
                )}
              </span>
              <span className="text-xs text-muted">
                {t("settings.sessions.lastActivity", {
                  time: formatRelativeTime(session.lastSeenAt, {
                    yesterdayLabel: t("mail.yesterday"),
                    locale: i18n.language,
                  }),
                })}
              </span>
              {/* #348: two sessions can share the same coarse device label
                  ("Chrome · Windows" twice) — the creation date is what
                  actually tells them apart. */}
              <span className="text-xs text-muted">
                {t("settings.sessions.created", {
                  time: formatRelativeTime(session.createdAt, {
                    yesterdayLabel: t("mail.yesterday"),
                    locale: i18n.language,
                  }),
                })}
              </span>
              {session.ip && (
                <span className="text-xs text-muted">
                  {t("settings.sessions.location", { ip: session.ip })}
                </span>
              )}
            </div>

            {!session.current && (
              <button
                type="button"
                onClick={() => revokeOne.mutate(session.id)}
                disabled={revokeOne.isPending && revokeOne.variables === session.id}
                className="shrink-0 rounded-[9px] border border-line-strong px-3 py-1 text-sm text-danger transition hover:border-danger hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("settings.sessions.close")}
              </button>
            )}
          </li>
        ))}
      </ul>

      {otherCount > 0 &&
        (confirmingCloseOthers ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-warn">
              {t("settings.sessions.confirmCloseOthersQuestion")}
            </span>
            <button
              type="button"
              onClick={() => revokeRest.mutate()}
              disabled={revokeRest.isPending}
              className="rounded-[11px] border border-line-strong px-3 py-1 text-sm font-semibold text-danger transition hover:border-danger hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("settings.sessions.confirmCloseOthersAction")}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingCloseOthers(false)}
              className="rounded-[9px] px-2 py-1 text-sm text-muted transition hover:bg-hover"
            >
              {t("settings.sessions.cancelCloseOthers")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingCloseOthers(true)}
            className="self-start rounded-[11px] border border-line-strong px-3 py-1 text-sm font-semibold text-danger transition hover:border-danger hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t("settings.sessions.closeOthers")}
          </button>
        ))}
    </div>
  );
}
