import {
  useEffect, useMemo, useRef,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode,
} from "react";
import {
  useInfiniteQuery, useMutation, useQueryClient, type InfiniteData,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import type { CustomLabel, EmailSummary, MessagesPage } from "@webmail/shared";
import { fetchMessages, updateMessage, PAGE_SIZE } from "./api";
import { mailErrorKey, mailRetry } from "./queryErrors";
import { Avatar } from "../../app/ui/Avatar";
import { CloseIcon, StarFilledIcon, StarIcon } from "../../app/ui/icons";
import { labelBackground, labelColor, labelDisplayName, userLabels } from "../../app/ui/labels";
import { formatRelativeTime } from "../../app/ui/relative-time";
import { isPlainShortcut } from "../../app/ui/shortcuts";
import { useToast } from "../../app/ui/toast";

interface MessageListProps {
  mailboxId?: string;
  hasKeyword?: string;
  query: string | null;
  selectedThreadId: string | null;
  onSelect: (email: EmailSummary) => void;
  virtualized?: boolean;
  to?: string;
  excludeTo?: string[];
  excludeMailboxId?: string;
  title?: string;
  onLabels?: (labels: string[]) => void;
  activeLabel?: string;
  onClearLabel?: () => void;
  archiveMailboxId: string | null;
  onArchived?: (email: EmailSummary) => void;
  // Same userPreferences-sourced list the Sidebar uses, so custom label chips
  // resolve their stored color/display name instead of falling back to the
  // deterministic hash color and raw JMAP slug.
  customLabels?: CustomLabel[];
}

function rowClassName(selected: boolean) {
  const base =
    "flex cursor-pointer items-start gap-3 border-b border-line py-[13px] pr-4 text-sm transition-colors hover:bg-hover";
  // The 3px selection border sits outside the padding box (border-l + pl-[14px]
  // both apply), so the row content lands 17px from the row's left edge either way.
  const highlight = selected
    ? "bg-sel border-l-[3px] border-l-accent pl-[14px]"
    : "border-l-[3px] border-l-transparent pl-[14px]";
  return [base, highlight].join(" ");
}

// Base row height (avatar + 3 text lines + vertical padding) — the original
// flat estimateSize constant, still correct for a row with no label chips.
const ROW_HEIGHT = 84;
// GH #87: a row with at least one label chip renders an extra
// "mt-1 flex gap-1" line below the preview. Without this, every row got the
// same fixed ROW_HEIGHT box from the virtualizer regardless of content, so a
// labeled row's chip line overflowed its absolutely-positioned box and bled
// into the next row's box — which paints later in DOM order, so an opaque
// selected background on the row below covered the chip. Growing the box for
// labeled rows keeps their content fully inside their own box, so there's
// nothing left to overlap.
const ROW_LABEL_EXTRA_HEIGHT = 26;

function rowHasLabelChip(keywords: Record<string, boolean>): boolean {
  return userLabels(keywords).length > 0;
}

// GH #89: one row per conversation (thread) instead of one row per email,
// Gmail-style. `representative` is the message shown in the row (sender,
// subject, preview, date) and the one passed to onSelect/handleSelect —
// opening a conversation still opens the full thread in ThreadView via its
// threadId, so any loaded message from that thread would do; the latest one
// is the most useful preview. `unread` is an aggregate: true if ANY loaded
// message in the thread is unread, so a thread doesn't look "read" just
// because its newest loaded message happens to be seen. Label chips
// deliberately use only the representative's keywords (not a union) — the
// task calls for keeping aggregation simple, and the representative's chips
// are what a Gmail-style client shows for a collapsed thread.
interface ConversationRow {
  threadId: string;
  representative: EmailSummary;
  messages: EmailSummary[];
  count: number;
  unread: boolean;
}

// Groups the currently-loaded (paginated) emails by threadId.
//
// LIMITATION (accepted, not fixed here): this only groups messages already
// loaded via pagination. A thread whose other messages live on a
// not-yet-fetched page shows a partial count until that page loads. The
// fully-correct fix is server-side thread collapsing (JMAP collapseThreads);
// that's a deliberate follow-up, out of scope for this client-side pass —
// fine for the seeded/demo data and typical folder sizes.
function groupIntoConversations(emails: EmailSummary[]): ConversationRow[] {
  const byThread = new Map<string, ConversationRow>();
  // Row order follows each thread's FIRST occurrence in `emails`. Since the
  // query returns messages newest-first, that's normally already the
  // thread's latest message, so grouping doesn't reshuffle the list — and
  // because this only depends on `emails` (via the caller's useMemo), the
  // order stays stable across unrelated re-renders.
  const order: string[] = [];
  for (const email of emails) {
    const existing = byThread.get(email.threadId);
    if (!existing) {
      byThread.set(email.threadId, {
        threadId: email.threadId,
        representative: email,
        messages: [email],
        count: 1,
        unread: !email.keywords.$seen,
      });
      order.push(email.threadId);
      continue;
    }
    existing.messages.push(email);
    existing.count += 1;
    if (!email.keywords.$seen) existing.unread = true;
    if (new Date(email.receivedAt).getTime() > new Date(existing.representative.receivedAt).getTime()) {
      existing.representative = email;
    }
  }
  return order.map((threadId) => byThread.get(threadId)!);
}

export function MessageList({
  mailboxId, hasKeyword, query, selectedThreadId, onSelect, virtualized = true, to, excludeTo,
  excludeMailboxId, title,
  onLabels, activeLabel, onClearLabel, archiveMailboxId, onArchived, customLabels = [],
}: MessageListProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const parentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const lastLabelsRef = useRef<string>("");
  // WAI-ARIA listbox roving tabindex needs to move DOM focus between options as
  // the user arrows through them; keep a live handle to each rendered option
  // keyed by its threadId (the same key React uses for the row).
  const optionRefs = useRef(new Map<string, HTMLDivElement>());

  const queryKey = useMemo(
    () =>
      [
        "mail", "messages", mailboxId ?? null, hasKeyword ?? null, query, to ?? null,
        (excludeTo ?? []).join(","), excludeMailboxId ?? null,
      ] as const,
    [mailboxId, hasKeyword, query, to, excludeTo, excludeMailboxId],
  );

  const messagesQuery = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      fetchMessages({
        mailboxId, hasKeyword, position: pageParam, limit: PAGE_SIZE, query: query ?? undefined, to, excludeTo,
        excludeMailboxId,
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

  const conversations = useMemo(() => groupIntoConversations(emails), [emails]);

  // Roving tabindex (WAI-ARIA listbox): exactly ONE option sits in the tab
  // order at a time — the selected conversation, or the first row when nothing
  // is selected yet — so Tab reaches the list as a single stop and Arrow keys
  // move between options from there. Every other option is tabIndex=-1.
  const rovingThreadId =
    conversations.find((conversation) => conversation.threadId === selectedThreadId)?.threadId ??
    conversations[0]?.threadId ??
    null;

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

  // GH #89 follow-up fix: `unread` on a conversation row is a THREAD
  // AGGREGATE (true if ANY loaded message in the thread is unread — see
  // groupIntoConversations), so marking only the representative $seen would
  // leave a thread permanently bold whenever its unread message wasn't the
  // representative. Opening a conversation must mark every currently-unread
  // LOADED message of that thread as seen — messages on not-yet-fetched
  // pages aren't part of the aggregate anyway, so this is complete for what
  // the row currently shows. There's no batch JMAP-set endpoint exposed by
  // the server, so this fires one PATCH per id via updateMessage.
  const markSeenMutation = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => updateMessage(id, { keywords: { $seen: true } }))),
    onMutate: async (ids) => {
      const idSet = new Set(ids);
      queryClient.setQueryData<InfiniteData<MessagesPage>>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            emails: page.emails.map((e) =>
              idSet.has(e.id) ? { ...e, keywords: { ...e.keywords, $seen: true } } : e),
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
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (email: EmailSummary) => {
      if (!archiveMailboxId) throw new Error("no archive mailbox");
      return updateMessage(email.id, { mailboxIds: { [archiveMailboxId]: true } });
    },
    onSuccess: (_data, email) => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["mail", "thread"] });
      showToast(`${t("mail.archived")} · ${t("mail.archivedHint")}`);
      onArchived?.(email);
    },
  });

  function handleSelect(conversation: ConversationRow) {
    onSelect(conversation.representative);
    const unreadIds = conversation.messages.filter((message) => !message.keywords.$seen).map((message) => message.id);
    if (unreadIds.length > 0) {
      markSeenMutation.mutate(unreadIds);
    }
  }

  function handleToggleStar(event: MouseEvent, email: EmailSummary) {
    event.stopPropagation();
    starMutation.mutate({ email, starred: !email.keywords.$flagged });
  }

  // Keyboard handling scoped to a focused option (not the global window
  // listener that owns j/k/s/e): Enter/Space open the conversation, and the
  // arrow keys move the roving selection to the adjacent option and carry DOM
  // focus with it, so a keyboard user can traverse the list without the mouse.
  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, conversation: ConversationRow) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleSelect(conversation);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const currentIndex = conversations.findIndex((row) => row.threadId === conversation.threadId);
    const target = conversations[event.key === "ArrowDown" ? currentIndex + 1 : currentIndex - 1];
    if (!target) return;
    handleSelect(target);
    optionRefs.current.get(target.threadId)?.focus();
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!isPlainShortcut(event)) return;
      if (emails.length === 0) return;

      if (event.key === "j") {
        event.preventDefault();
        // Moves by CONVERSATION, not by raw email — one step skips the whole
        // thread instead of landing on its next loaded message.
        const currentIndex = conversations.findIndex((conversation) => conversation.threadId === selectedThreadId);
        const nextConversation = currentIndex === -1 ? conversations[0] : conversations[currentIndex + 1];
        if (nextConversation) handleSelect(nextConversation);
        return;
      }

      if (event.key === "k") {
        event.preventDefault();
        const currentIndex = conversations.findIndex((conversation) => conversation.threadId === selectedThreadId);
        if (currentIndex <= 0) return;
        const previousConversation = conversations[currentIndex - 1];
        if (previousConversation) handleSelect(previousConversation);
        return;
      }

      const selectedEmail = emails.find((email) => email.threadId === selectedThreadId);
      if (!selectedEmail) return;

      if (event.key === "s") {
        event.preventDefault();
        starMutation.mutate({ email: selectedEmail, starred: !selectedEmail.keywords.$flagged });
        return;
      }

      if (event.key === "e" && archiveMailboxId) {
        event.preventDefault();
        archiveMutation.mutate(selectedEmail);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emails, conversations, selectedThreadId, archiveMailboxId]);

  const rowVirtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const conversation = conversations[index];
      return conversation && rowHasLabelChip(conversation.representative.keywords)
        ? ROW_HEIGHT + ROW_LABEL_EXTRA_HEIGHT
        : ROW_HEIGHT;
    },
    overscan: 10,
  });

  const virtualItems = virtualized ? rowVirtualizer.getVirtualItems() : [];

  useEffect(() => {
    if (!virtualized) return;
    const lastItem = virtualItems[virtualItems.length - 1];
    if (!lastItem) return;
    // Compare against conversations.length, not emails.length: the
    // virtualizer's item count is now the grouped row count, which is <=
    // emails.length once threads collapse, so comparing against the raw
    // email count would stop triggering fetchNextPage before the visible
    // window actually reaches the end of the loaded (grouped) list.
    if (lastItem.index >= conversations.length - 1 && messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      messagesQuery.fetchNextPage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualized, virtualItems, conversations.length, messagesQuery.hasNextPage, messagesQuery.isFetchingNextPage]);

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

  function renderRow(conversation: ConversationRow) {
    const email = conversation.representative;
    const unread = conversation.unread;
    const selected = conversation.threadId === selectedThreadId;
    const fromLabel = email.from[0]?.name || email.from[0]?.email || "";
    const subjectLabel = email.subject || t("mail.noSubject");
    const dateLabel = formatRelativeTime(email.receivedAt, {
      yesterdayLabel: t("mail.yesterday"),
      locale: i18n.language,
    });
    const starred = Boolean(email.keywords.$flagged);
    const rowLabels = userLabels(email.keywords).slice(0, 2);

    // GH #225: the star used to be a <button> INSIDE the role="option"
    // element. An option must not have interactive descendants — a screen
    // reader announces the option as a single selectable unit, so a control
    // buried in it is neither announced as its own control nor reliably
    // operable. The row is now a presentational wrapper holding the option and
    // the star side by side, so the star is a real, focusable button again and
    // the option contains nothing focusable.
    //
    // The wrapper keeps every one of the row's own styles (border, padding,
    // selection highlight, hover), and the option takes flex-1 so it still
    // spans everything left of the star — the click target, the roving
    // tabIndex, the Arrow-key handler and the ref the roving focus moves
    // between (GH #200) all stay exactly where they were.
    return (
      // data-testid, not a role: the wrapper is deliberately presentational
      // (the option is what carries the semantics). It exists so callers that
      // need "this row's star button" — which is no longer inside the option —
      // have one stable handle for the whole row.
      <div
        key={conversation.threadId}
        data-testid="conversation-row"
        className={rowClassName(selected)}
      >
        <div
          ref={(el) => {
            if (el) optionRefs.current.set(conversation.threadId, el);
            else optionRefs.current.delete(conversation.threadId);
          }}
          role="option"
          aria-selected={selected}
          tabIndex={conversation.threadId === rovingThreadId ? 0 : -1}
          onClick={() => handleSelect(conversation)}
          onKeyDown={(event) => handleOptionKeyDown(event, conversation)}
          className="flex min-w-0 flex-1 items-start gap-3"
        >
          <Avatar name={email.from[0]?.name ?? null} email={email.from[0]?.email ?? "?"} size={38} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span
                aria-hidden="true"
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${unread ? "bg-accent" : "bg-transparent"}`}
              />
              <span className={`min-w-0 flex-1 truncate text-[14px] ${unread ? "font-bold" : "font-medium"}`}>
                {fromLabel}
              </span>
              {conversation.count > 1 && (
                <span
                  aria-label={t("mail.conversationCount", { count: conversation.count })}
                  className="shrink-0 text-xs font-semibold text-muted"
                >
                  {conversation.count}
                </span>
              )}
              <span className="shrink-0 text-xs text-muted">{dateLabel}</span>
            </div>
            <div className={`truncate text-[13.5px] ${unread ? "font-[650]" : "font-[420]"}`}>{subjectLabel}</div>
            <div className="truncate text-[12.5px] text-muted">{email.preview}</div>
            {rowLabels.length > 0 && (
              <div className="mt-1 flex gap-1">
                {rowLabels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full px-2 py-[2px] text-[11px] font-semibold"
                    style={{ color: labelColor(label, customLabels), background: labelBackground(label, customLabels) }}
                  >
                    {labelDisplayName(label, customLabels)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label={t(starred ? "mail.unstar" : "mail.star")}
          onClick={(event) => handleToggleStar(event, email)}
          className={`flex h-6 w-6 shrink-0 items-center justify-center ${starred ? "text-star" : "text-muted hover:text-ink"}`}
        >
          {starred ? <StarFilledIcon size={16} /> : <StarIcon size={16} />}
        </button>
      </div>
    );
  }

  // GH #225: neither listbox had an accessible name, so a screen reader
  // announced only "list box" with no idea which mailbox or view it belongs
  // to — and this component renders several of them across the app (folder,
  // label, group and starred views). `title` is the view's own visible
  // heading, which is exactly the right name when there is one; the generic
  // label covers the callers that render the list without a header.
  const listboxLabel = title ?? t("mail.messageListLabel");

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
      <div ref={parentRef} role="listbox" aria-label={listboxLabel} className="min-h-0 flex-1 overflow-y-auto">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualItems.map((virtualRow) => {
            const conversation = conversations[virtualRow.index];
            if (!conversation) return null;
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
                {renderRow(conversation)}
              </div>
            );
          })}
        </div>
      </div>
    );
  } else {
    content = (
      <div role="listbox" aria-label={listboxLabel} className="min-h-0 flex-1 overflow-y-auto">
        {conversations.map((conversation) => renderRow(conversation))}
        {messagesQuery.hasNextPage && <div ref={sentinelRef} aria-hidden="true" data-testid="load-more-sentinel" />}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {title && (
        <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-[18px]">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className="truncate text-[15px] font-[650]">{title}</h2>
            {activeLabel && (
              <span
                className="flex h-6 shrink-0 items-center gap-1.5 rounded-full px-[9px] text-xs font-semibold"
                style={{
                  color: labelColor(activeLabel, customLabels),
                  background: labelBackground(activeLabel, customLabels),
                }}
              >
                {labelDisplayName(activeLabel, customLabels)}
                <button
                  type="button"
                  aria-label={t("mail.clearLabel")}
                  onClick={onClearLabel}
                  className="flex h-3.5 w-3.5 items-center justify-center opacity-70"
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
