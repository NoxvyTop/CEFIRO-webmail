import { useEffect, useMemo, useRef } from "react";
import {
  useInfiniteQuery, useMutation, useQueryClient, type InfiniteData,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import type { EmailSummary, MessagesPage } from "@webmail/shared";
import { fetchMessages, updateMessage, PAGE_SIZE } from "./api";
import { mailErrorKey, mailRetry } from "./queryErrors";

interface MessageListProps {
  mailboxId: string;
  query: string | null;
  selectedThreadId: string | null;
  onSelect: (email: EmailSummary) => void;
  virtualized?: boolean;
  to?: string;
  excludeTo?: string[];
}

function rowClassName(unread: boolean, selected: boolean) {
  const base = "flex cursor-pointer items-start gap-2 border-b p-2 text-sm";
  const weight = unread ? "font-semibold" : "font-normal";
  const highlight = selected ? "bg-gray-100" : "";
  return [base, weight, highlight].filter(Boolean).join(" ");
}

export function MessageList({
  mailboxId, query, selectedThreadId, onSelect, virtualized = true, to, excludeTo,
}: MessageListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const parentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const queryKey = useMemo(
    () => ["mail", "messages", mailboxId, query, to ?? null, (excludeTo ?? []).join(",")] as const,
    [mailboxId, query, to, excludeTo],
  );

  const messagesQuery = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      fetchMessages({
        mailboxId, position: pageParam, limit: PAGE_SIZE, query: query ?? undefined, to, excludeTo,
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

  function handleSelect(email: EmailSummary) {
    onSelect(email);
    if (!email.keywords.$seen) {
      markSeenMutation.mutate(email);
    }
  }

  const rowVirtualizer = useVirtualizer({
    count: emails.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
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
          <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-600" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate">{fromLabel}</span>
            <span className="shrink-0 text-xs text-gray-500">{dateLabel}</span>
          </div>
          <div className="truncate">{subjectLabel}</div>
          <div className="truncate text-xs text-gray-500">{email.preview}</div>
        </div>
      </div>
    );
  }

  if (messagesQuery.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-amber-700">
        {t(mailErrorKey(messagesQuery.error))}
      </p>
    );
  }

  if (!messagesQuery.isLoading && emails.length === 0) {
    return <p className="p-4 text-sm text-gray-500">{t("mail.empty")}</p>;
  }

  if (virtualized) {
    return (
      <div ref={parentRef} role="listbox" className="h-full overflow-y-auto">
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
  }

  return (
    <div role="listbox" className="h-full overflow-y-auto">
      {emails.map((email) => renderRow(email))}
      {messagesQuery.hasNextPage && <div ref={sentinelRef} aria-hidden="true" data-testid="load-more-sentinel" />}
    </div>
  );
}
