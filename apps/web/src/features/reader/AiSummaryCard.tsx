import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MailApiError } from "../mailbox/api";
import { fetchSummary, summarizeThread } from "./aiApi";

interface AiSummaryCardProps {
  messageId: string;
  /** Id of the thread `messageId` belongs to — only used when `messageCount > 1`. */
  threadId: string;
  /**
   * Total messages in the thread. `> 1` switches the card to a whole-thread
   * conversation summary (GH #116) instead of summarizing just this one
   * message — a single email's summarize route would otherwise only see the
   * last message, quoted trail and all.
   */
  messageCount: number;
}

// Returns the i18n key for the inline error, or null when the card should
// hide itself entirely — the backend's `ai_disabled` domain error means the
// software-level gate is off, so there is nothing useful to show or retry.
function aiErrorKey(error: unknown): string | null {
  if (error instanceof MailApiError) {
    if (error.code === "ai_disabled") return null;
    if (error.code === "ai_provider_error") return "mail.errors.ai_provider_error";
    // GH #165: "the provider never answered" is a different thing to tell the
    // user than "the provider answered with garbage" — one is worth retrying
    // right away, the other is not. The server keeps them apart as separate
    // codes, so the card must too, or the distinction dies at the last step.
    if (error.code === "upstream_timeout") return "mail.errors.upstream_timeout";
  }
  return "mail.errors.generic";
}

export function AiSummaryCard({ messageId, threadId, messageCount }: AiSummaryCardProps) {
  const { t } = useTranslation();
  const isThread = messageCount > 1;

  // Cached under a stable key so the summary persists across re-renders /
  // re-visits of the thread within the session, without being regenerated —
  // enabled:false means it only runs when explicitly triggered via refetch().
  const query = useQuery({
    queryKey: isThread ? ["ai", "summary", "thread", threadId] : ["ai", "summary", messageId],
    queryFn: () => (isThread ? summarizeThread(threadId) : fetchSummary(messageId)),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  if (query.isError) {
    const key = aiErrorKey(query.error);
    if (key === null) return null;
    return (
      <div className="mt-[26px] w-full rounded-xl border border-line bg-soft px-[18px] py-3.5">
        <p role="alert" className="text-sm text-warn">
          {t(key)}
        </p>
      </div>
    );
  }

  const idle = !query.isFetched && !query.isFetching;
  const ready = query.isFetched && !query.isFetching;

  return (
    <div className="mt-[26px] w-full rounded-xl border border-line bg-soft px-[18px] py-3.5">
      {idle && (
        <button
          type="button"
          onClick={() => query.refetch()}
          className="flex items-center gap-2 bg-transparent text-[13.5px] font-semibold text-accent-text transition hover:opacity-80"
        >
          <span aria-hidden="true" className="text-[15px]">✦</span>
          {t(isThread ? "mail.summarizeConversation" : "mail.summarizeWithAi")}
        </button>
      )}
      {query.isFetching && (
        <p className="flex animate-pulse items-center gap-2 text-[13.5px] font-semibold text-accent-text">
          <span aria-hidden="true">✦</span> {t("mail.aiSummaryLoading")}
        </p>
      )}
      {ready && (
        <div role="region" aria-label={t("mail.aiSummaryTitle")} style={{ animation: "fadeUp 0.3s ease" }}>
          <h3 className="mb-[9px] flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-accent-text">
            <span aria-hidden="true">✦</span> {t("mail.aiSummaryTitle")}
          </h3>
          <ul className="flex list-disc flex-col gap-[5px] pl-[18px] text-[13.5px] leading-[1.5]">
            {(query.data ?? []).map((bullet, index) => (
              <li key={index}>{bullet}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
