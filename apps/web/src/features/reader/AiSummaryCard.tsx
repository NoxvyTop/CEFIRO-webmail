import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MailApiError } from "../mailbox/api";
import { fetchSummary } from "./aiApi";

interface AiSummaryCardProps {
  messageId: string;
}

// Returns the i18n key for the inline error, or null when the card should
// hide itself entirely — the backend's `ai_disabled` domain error means the
// software-level gate is off, so there is nothing useful to show or retry.
function aiErrorKey(error: unknown): string | null {
  if (error instanceof MailApiError) {
    if (error.code === "ai_disabled") return null;
    if (error.code === "ai_provider_error") return "mail.errors.ai_provider_error";
  }
  return "mail.errors.generic";
}

export function AiSummaryCard({ messageId }: AiSummaryCardProps) {
  const { t } = useTranslation();

  // Cached under a stable key so the summary persists across re-renders /
  // re-visits of the thread within the session, without being regenerated —
  // enabled:false means it only runs when explicitly triggered via refetch().
  const query = useQuery({
    queryKey: ["ai", "summary", messageId],
    queryFn: () => fetchSummary(messageId),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  if (query.isError) {
    const key = aiErrorKey(query.error);
    if (key === null) return null;
    return (
      <p role="alert" className="mt-4 text-sm text-warn">
        {t(key)}
      </p>
    );
  }

  if (!query.isFetched && !query.isFetching) {
    return (
      <button
        type="button"
        onClick={() => query.refetch()}
        className="mt-4 self-start rounded-[11px] border border-line bg-soft px-3 py-1.5 text-sm font-semibold text-accent transition hover:brightness-[1.07] active:scale-[0.98]"
      >
        {t("mail.summarizeWithAi")}
      </button>
    );
  }

  return (
    <div
      role="region"
      aria-label={t("mail.aiSummaryTitle")}
      className="mt-4 rounded-xl border border-line bg-soft p-4"
    >
      <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-accent">
        {t("mail.aiSummaryTitle")}
      </h3>
      {query.isFetching ? (
        <p className="mt-2 animate-pulse text-sm text-muted">{t("mail.aiSummaryLoading")}</p>
      ) : (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-sm">
          {(query.data ?? []).map((bullet, index) => (
            <li key={index}>{bullet}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
