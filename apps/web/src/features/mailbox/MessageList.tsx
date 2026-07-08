import { useEffect, useMemo, useRef, type MouseEvent, type ReactNode } from "react";
import {
  useInfiniteQuery, useMutation, useQueryClient, type InfiniteData,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import type { EmailSummary, MessagesPage } from "@webmail/shared";
import { fetchMessages, updateMessage, PAGE_SIZE } from "./api";
import { mailErrorKey, mailRetry } from "./queryErrors";
import { Avatar } from "../../app/ui/Avatar";
import { CloseIcon, StarFilledIcon, StarIcon } from "../../app/ui/icons";
import { labelBackground, labelColor, userLabels } from "../../app/ui/labels";

interface MessageListProps {
  mailboxId?: string;
  hasKeyword?: string;
  query: string | null;
  selectedThreadId: string | null;
  onSelect: (email: EmailSummary) => void;
  virtualized?: boolean;
  to?: string;
  excludeTo?: string[];
  title?: string;
  onLabels?: (labels: string[]) => void;
  activeLabel?: string;
  onClearLabel?: () => void;
}

function rowClassName(unread: boolean, selected: boolean) {
  const base =
    "flex cursor-pointer items-start gap-2 border-b border-line p-3 text-sm transition-colors hover:bg-hover";
  const weight = unread ? "font-semibold" : "font-normal";
  const highlight = selected
    ? "bg-sel border-l-[3px] border-l-accent pl-[9px]"
    : "border-l-[3px] border-l-transparent pl-[9px]";
  return [base, weight, highlight].join(" ");
}

export function MessageList({
  mailboxId, hasKeyword, query, selectedThreadId, onSelect, virtualized = true, to, excludeTo, title,
  onLabels, activeLabel, onClearLabel,
}: MessageListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const parentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const lastLabelsRef = useRef<string>("");

  const queryKey = useMemo(
    () =>
      ["mail", "messages", mailboxId ?? null, hasKeyword ?? null, query, to ?? null, (excludeTo ?? []).join(",")] as const,
    [mailboxId, hasKeyword, query, to, excludeTo],
  );

  const messagesQuery = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      fetchMessages({
        mailboxId, hasKeyword, position: pageParam, limit: PAGE_SIZE, query: query ?? undefined, to, excludeTo,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.position + lastPage.emails.length < lastPage.total
        ? lastPage.position + lastPage.emails.length
        : undefined,
    retry: mailRetry,
  });

  const emails = useMemo(
    () => messagesQuery.data?.pages.flatMap((page) => page.emails) ?? [],
    [messagesQuery.data],
  );

  const total = messagesQuery.data?.pages[0]?.total ?? 0;

  useEffect(() => {
    if (!onLabels) return;
    const union = new Set<string>();
    for (const email of emails) {
      for (const label of userLabels(email.keywords)) union.add(label);
    }
    const sorted = Array.from(union).sort();
    const joined = sorted.join(",");
    if (joined !== lastLabelsRef.current) {
      lastLabelsRef.current = joined;
      onLabels(sorted);
    }
  }, [emails, onLabels]);

  const markSeenMutation = useMutation({
    mutationFn: (email: EmailSummary) => updateMessage(email.id, { keywords: { $seen: true } }),
    onMutate: async (email) => {
      queryClient.setQueryData<InfiniteData<MessagesPage>>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            emails: page.emails.map((e) =>
              e.id === email.id ? { ...e, keywords: { ...e.keywords, $seen: true } } : e),
          })),
        };
      });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const starMutation = useMutation({
    mutationFn: ({ email, starred }: { email: EmailSummary; starred: boolean }) =>
      updateMessage(email.id, { keywords: { $flagged: starred } }),
    onMutate: async ({ email, starred }) => {
      queryClient.setQueryData<InfiniteData<MessagesPage>>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            emails: page.emails.map((e) =>
              e.id === email.id ? { ...e, keywords: { ...e.keywords, $flagged: starred } } : e),
          })),
        };
      });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail", "thread"] });
    },
  });

  function handleSelect(email: EmailSummary) {
    onSelect(email);
    if (!email.keywords.$seen) {
      markSeenMutation.mutate(email);
    }
  }

  function handleToggleStar(event: MouseEvent, email: EmailSummary) {
    event.stopPropagation();
    starMutation.mutate({ email, starred: !email.keywords.$flagged });
  }

  const rowVirtualizer = useVirtualizer({
    count: emails.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 10,
  });

  const virtualItems = virtualized ? rowVirtualizer.getVirtualItems() : [];

  useEffect(() => {
    if (!virtualized) return;
    const lastItem = virtualItems[virtualItems.length - 1];
    if (!lastItem) return;
    if (lastItem.index >= emails.length - 1 && messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      messagesQuery.fetchNextPage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualized, virtualItems, emails.length, messagesQuery.hasNextPage, messagesQuery.isFetchingNextPage]);

  useEffect(() => {
    if (virtualized) return;
    if (!sentinelRef.current || !messagesQuery.hasNextPage) return;
    if (typeof IntersectionObserver === "undefined") {
      if (!messagesQuery.isFetchingNextPage) messagesQuery.fetchNextPage();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !messagesQuery.isFetchingNextPage) {
        messagesQuery.fetchNextPage();
      }
    });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualized, messagesQuery.hasNextPage, messagesQuery.isFetchingNextPage, emails.length]);

  function renderRow(email: EmailSummary) {
    const unread = !email.keywords.$seen;
    const selected = email.threadId === selectedThreadId;
    const fromLabel = email.from[0]?.name || email.from[0]?.email || "";
    const subjectLabel = email.subject || t("mail.noSubject");
    const date = new Date(email.receivedAt);
    const dateLabel = Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
    const starred = Boolean(email.keywords.$flagged);
    const rowLabels = userLabels(email.keywords).slice(0, 2);

    return (
      <div
        key={email.id}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={() => handleSelect(email)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") handleSelect(email);
        }}
        className={rowClassName(unread, selected)}
      >
        {unread && (
          <span aria-hidden="true" className="mt-4 h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />
        )}
        <Avatar name={email.from[0]?.name ?? null} email={email.from[0]?.email ?? "?"} size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[14px]">{fromLabel}</span>
            <span className="shrink-0 text-xs text-muted">{dateLabel}</span>
          </div>
          <div className="truncate text-[13.5px]">{subjectLabel}</div>
          <div className="truncate text-[12.5px] text-muted">{email.preview}</div>
          {rowLabels.length > 0 && (
            <div className="mt-1 flex gap-1">
              {rowLabels.map((label) => (
                <span
                  key={label}
                  className="rounded-full px-2 text-[11px]"
                  style={{ color: labelColor(label), background: labelBackground(label) }}
                >
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label={t(starred ? "mail.unstar" : "mail.star")}
          onClick={(event) => handleToggleStar(event, email)}
          className={`flex h-6 w-6 shrink-0 items-center justify-center ${starred ? "" : "text-muted hover:text-ink"}`}
          style={starred ? { color: "#E8C24A" } : undefined}
        >
          {starred ? <StarFilledIcon size={16} /> : <StarIcon size={16} />}
        </button>
      </div>
    );
  }

  let content: ReactNode;

  if (messagesQuery.isError) {
    content = (
      <p role="alert" className="p-4 text-sm text-warn">
        {t(mailErrorKey(messagesQuery.error))}
      </p>
    );
  } else if (!messagesQuery.isLoading && emails.length === 0) {
    content = <p className="p-4 text-sm text-muted">{t("mail.empty")}</p>;
  } else if (virtualized) {
    content = (
      <div ref={parentRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualItems.map((virtualRow) => {
            const email = emails[virtualRow.index];
            if (!email) return null;
            return (
              <div
                key={virtualRow.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderRow(email)}
              </div>
            );
          })}
        </div>
      </div>
    );
  } else {
    content = (
      <div role="listbox" className="min-h-0 flex-1 overflow-y-auto">
        {emails.map((email) => renderRow(email))}
        {messagesQuery.hasNextPage && <div ref={sentinelRef} aria-hidden="true" data-testid="load-more-sentinel" />}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {title && (
        <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            {activeLabel && (
              <span
                className="flex shrink-0 items-center gap-1 rounded-full px-2 text-[11px]"
                style={{ color: labelColor(activeLabel), background: labelBackground(activeLabel) }}
              >
                {activeLabel}
                <button
                  type="button"
                  aria-label={t("mail.clearLabel")}
                  onClick={onClearLabel}
                  className="flex h-3.5 w-3.5 items-center justify-center"
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            )}
          </div>
          <span className="shrink-0 text-xs text-muted">{t("mail.messageCount", { count: total })}</span>
        </div>
      )}
      {content}
    </div>
  );
}
