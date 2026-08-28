import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MailApiError } from "../mailbox/api";
import { SparkleIcon } from "../../app/ui/icons";
import { fetchSummary, summarizeThread } from "./aiApi";
import { readCachedSummary, summaryStorageKey, writeCachedSummary } from "./summaryCache";

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
  /**
   * #308: the thread's email ids in chronological order (oldest→newest). Used
   * only in thread mode, to key the persistent cache by the id set so a new
   * reply misses (mirrors the server's thread content key). Optional so a
   * standalone/message-mode caller need not supply it.
   */
  emailIds?: string[];
}

// Returns the i18n key for the inline error, or null when the card should
// hide itself entirely — the backend's `ai_disabled` domain error means the
// software-level gate is off, so there is nothing useful to show or retry.
function aiErrorKey(error: unknown): string | null {
  if (error instanceof MailApiError) {
    if (error.code === "ai_disabled") return null;
    if (error.code === "ai_provider_error") return "mail.errors.ai_provider_error";
    // GH #194: the per-user AI quota (429). Tell the user to wait rather than
    // showing the generic failure — it is transient and self-clearing.
    if (error.code === "ai_rate_limited") return "mail.errors.ai_rate_limited";
    // GH #165: "the provider never answered" is a different thing to tell the
    // user than "the provider answered with garbage" — one is worth retrying
    // right away, the other is not. The server keeps them apart as separate
    // codes, so the card must too, or the distinction dies at the last step.
    if (error.code === "upstream_timeout") return "mail.errors.upstream_timeout";
  }
  return "mail.errors.generic";
}

export function AiSummaryCard({ messageId, threadId, messageCount, emailIds }: AiSummaryCardProps) {
  const { t } = useTranslation();
  const isThread = messageCount > 1;

  // #308: the localStorage key this summary is stored under. Cheap to recompute
  // per render (a small FNV hash over a few ids), so it stays a plain call rather
  // than a memo — the caller hands a fresh `emailIds` array each render, which
  // would defeat a naive memo anyway.
  const cacheKey = summaryStorageKey({ isThread, messageId, threadId, messageCount, emailIds });

  // #308: read the persisted summary ONCE on mount so a full reload re-shows it
  // immediately, with no fetch. React Query's own cache dies with the tab; this
  // is what survives the reload. Seeded as `initialData` below.
  const [cachedBullets] = useState(() => readCachedSummary(cacheKey));

  // Cached under a stable key so the summary persists across re-renders /
  // re-visits of the thread within the session, without being regenerated —
  // enabled:false means it only runs when explicitly triggered via refetch().
  const query = useQuery({
    queryKey: isThread ? ["ai", "summary", "thread", threadId] : ["ai", "summary", messageId],
    queryFn: async () => {
      const bullets = isThread ? await summarizeThread(threadId) : await fetchSummary(messageId);
      // #308: refresh the persistent cache on every successful (re)generation so
      // the next reload shows the just-generated bullets without a round-trip.
      writeCachedSummary(cacheKey, bullets);
      return bullets;
    },
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    // #308: a cache hit renders immediately without a fetch (enabled:false +
    // staleTime:Infinity mean React Query won't refetch over it).
    initialData: cachedBullets,
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

  // #308: keyed on `query.data` rather than `isFetched` so a summary restored
  // from localStorage (seeded via initialData, which is NOT a fetch) shows on
  // mount. A miss leaves data undefined → the "Resumir" trigger is offered.
  const idle = query.data === undefined && !query.isFetching;
  const ready = query.data !== undefined && !query.isFetching;

  return (
    <div className="mt-[26px] w-full rounded-xl border border-line bg-soft px-[18px] py-3.5">
      {idle && (
        <button
          type="button"
          onClick={() => query.refetch()}
          className="flex items-center gap-2 bg-transparent text-[13.5px] font-semibold text-accent-text transition hover:opacity-80"
        >
          <SparkleIcon size={15} />
          {t(isThread ? "mail.summarizeConversation" : "mail.summarizeWithAi")}
        </button>
      )}
      {query.isFetching && (
        <p className="flex animate-pulse items-center gap-2 text-[13.5px] font-semibold text-accent-text">
          <SparkleIcon size={15} /> {t("mail.aiSummaryLoading")}
        </p>
      )}
      {/* GH #253: a named <section> IS a region — the explicit role="region" on
          a div was ARIA standing in for markup that already exists. */}
      {ready && (
        <section aria-label={t("mail.aiSummaryTitle")} style={{ animation: "fadeUp 0.3s ease" }}>
          <h3 className="mb-[9px] flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-accent-text">
            <SparkleIcon size={13} /> {t("mail.aiSummaryTitle")}
          </h3>
          <ul className="flex list-disc flex-col gap-[5px] pl-[18px] text-[13.5px] leading-[1.5]">
            {(query.data ?? []).map((bullet, index) => (
              <li key={index}>{bullet}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
