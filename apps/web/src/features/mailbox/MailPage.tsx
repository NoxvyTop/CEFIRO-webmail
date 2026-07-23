import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import type { CustomLabel, EmailSummary } from "@webmail/shared";
import { fetchMailboxes, fetchThread } from "./api";
import { deriveGroupAddresses, fetchPreferences, updatePreferences } from "./groups";
import { isUnlinkedMailboxError, mailErrorKey, mailRetry } from "./queryErrors";
import { MessageList } from "./MessageList";
import { Sidebar } from "./Sidebar";
import { useMailEvents } from "./useMailEvents";
import { ThreadView } from "../reader/ThreadView";
import { CefiroLogo } from "../../app/ui/CefiroLogo";
import { folderName } from "../../app/ui/folders";
import { useToast } from "../../app/ui/toast";
import { Composer } from "../composer/Composer";
import { fetchIdentities } from "../composer/api";
import { buildEditDraft, emptyDraft, forwardDraft, replyDraft, type ComposerDraft } from "../composer/reply";
import { isPlainShortcut } from "../../app/ui/shortcuts";
import { useAuth } from "../auth/useAuth";
import {
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  useResizablePane,
} from "../../app/ui/useResizablePane";

export function MailPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { width: listWidth, startDrag, handleKeyDown } = useResizablePane();
  const isAdmin = user?.role === "admin";

  useMailEvents(true);

  const mailboxParam = searchParams.get("mailbox");
  const threadParam = searchParams.get("thread");
  const queryParam = searchParams.get("q");
  const composeParam = searchParams.get("compose");
  const groupParam = searchParams.get("group");
  const starredParam = searchParams.get("starred") === "1";
  const labelParam = searchParams.get("label");
  const composeMatch = composeParam?.match(/^(reply|reply-all|forward|draft):(.+)$/) ?? null;
  const composeMode = composeMatch?.[1];
  const composeEmailId = composeMatch?.[2];
  const [availableLabels, setAvailableLabels] = useState<string[]>([]);

  const mailboxesQuery = useQuery({
    queryKey: ["mail", "mailboxes"],
    queryFn: fetchMailboxes,
    retry: mailRetry,
  });

  const identitiesQuery = useQuery({
    queryKey: ["mail", "identities"],
    queryFn: fetchIdentities,
  });
  // CLARO-10: gates both the Redactar button's disabled state and the "c"
  // shortcut — without at least one identity, composing has nothing to send
  // from (most commonly: the mailbox isn't linked yet).
  const hasIdentities = Boolean(identitiesQuery.data && identitiesQuery.data.length > 0);

  // CLARO-07/OSCURO-05: mail_credentials_missing is onboarding, not a server
  // error — everything else (mail_not_configured, network failures, etc.)
  // keeps the generic alert treatment.
  const unlinkedMailbox = mailboxesQuery.isError && isUnlinkedMailboxError(mailboxesQuery.error);
  const otherMailboxError = mailboxesQuery.isError && !unlinkedMailbox;

  const preferencesQuery = useQuery({
    queryKey: ["mail", "preferences"],
    queryFn: fetchPreferences,
  });
  const preferences = preferencesQuery.data;
  const customLabels = preferences?.customLabels ?? [];

  const toggleGroupMailInInboxMutation = useMutation({
    mutationFn: (next: boolean) => updatePreferences({ groupMailInMainInbox: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail", "preferences"] });
      queryClient.invalidateQueries({ queryKey: ["mail", "messages"] });
    },
  });

  const createLabelMutation = useMutation({
    mutationFn: (label: CustomLabel) => updatePreferences({ customLabels: [...customLabels, label] }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail", "preferences"] });
    },
  });

  const deleteLabelMutation = useMutation({
    mutationFn: (slug: string) =>
      updatePreferences({ customLabels: customLabels.filter((label) => label.slug !== slug) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail", "preferences"] });
    },
  });

  const groups = useMemo(
    () => (user ? deriveGroupAddresses(identitiesQuery.data ?? [], user.email) : []),
    [identitiesQuery.data, user],
  );

  const groupAddresses = useMemo(() => groups.map((group) => group.email), [groups]);

  const composeThreadQuery = useQuery({
    queryKey: ["mail", "thread", threadParam ?? ""],
    queryFn: () => fetchThread(threadParam as string),
    enabled: Boolean(composeMatch) && Boolean(threadParam),
  });

  const mailboxes = mailboxesQuery.data ?? [];

  const inboxMailboxId = useMemo(() => {
    if (mailboxes.length === 0) return null;
    const inbox = mailboxes.find((mailbox) => mailbox.role === "inbox");
    return (inbox ?? mailboxes[0])?.id ?? null;
  }, [mailboxes]);

  const archiveMailboxId = useMemo(
    () => mailboxes.find((mailbox) => mailbox.role === "archive")?.id ?? null,
    [mailboxes],
  );

  // Delete-on-send target: after sending an edited draft (compose=draft:<id>),
  // the ORIGINAL draft is moved here so it doesn't linger as a stale copy
  // (Gmail removes the draft you sent) — see useComposer.ts's send().
  const trashMailboxId = useMemo(
    () => mailboxes.find((mailbox) => mailbox.role === "trash")?.id ?? null,
    [mailboxes],
  );

  const selectedMailboxId = useMemo(() => {
    if (mailboxParam) return mailboxParam;
    return inboxMailboxId;
  }, [mailboxParam, inboxMailboxId]);

  const messageListMailboxId =
    starredParam ? undefined : (groupParam ? inboxMailboxId : selectedMailboxId) ?? undefined;

  const messageListTo = starredParam ? undefined : (groupParam ?? undefined);

  const isMainInboxSelected =
    !starredParam && !groupParam && selectedMailboxId !== null && selectedMailboxId === inboxMailboxId;

  const messageListExcludeTo =
    isMainInboxSelected && preferences?.groupMailInMainInbox === false && groupAddresses.length > 0
      ? groupAddresses
      : undefined;

  const messageListHasKeyword = starredParam
    ? (labelParam ? `$flagged,${labelParam}` : "$flagged")
    : (labelParam ?? undefined);

  const selectedMailbox = mailboxes.find((mailbox) => mailbox.id === selectedMailboxId);
  const messageListTitle = starredParam
    ? t("mail.starredView")
    : groupParam
      ? groupParam
      : (selectedMailbox ? folderName(selectedMailbox, t) : undefined);

  // The starred view is not tied to any single mailbox, so the sidebar must not
  // highlight a mailbox row (e.g. Inbox) while it is active. `selectedMailboxId`
  // itself keeps deriving from the URL/inbox fallback for query purposes; only
  // the value handed to the Sidebar for its aria-current styling is nulled out.
  const sidebarSelectedMailboxId = starredParam ? null : selectedMailboxId;

  function handleSelectMailbox(mailboxId: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("mailbox", mailboxId);
      next.delete("thread");
      next.delete("q");
      next.delete("group");
      next.delete("starred");
      return next;
    });
  }

  function handleSelectGroup(address: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("group", address);
      next.delete("thread");
      next.delete("starred");
      return next;
    });
  }

  function handleSelectStarred() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("starred", "1");
      next.delete("mailbox");
      next.delete("thread");
      next.delete("group");
      next.delete("label");
      return next;
    });
  }

  function handleSelectLabel(label: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (next.get("label") === label) {
        next.delete("label");
      } else {
        next.set("label", label);
      }
      next.delete("thread");
      return next;
    });
  }

  function handleClearLabel() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("label");
      next.delete("thread");
      return next;
    });
  }

  function handleSelectMessage(email: EmailSummary) {
    // Gmail behavior: a draft has nothing to "read" — clicking it should
    // resume writing, not open the read-only reader. The JMAP $draft keyword
    // is the signal (not "is the currently selected mailbox Drafts"), since
    // it travels with the message regardless of which list/view produced it
    // (e.g. a future combined/search view mixing drafts with other mail).
    //
    // `thread` is set alongside `compose` purely so resolveComposeDraft can
    // reuse the existing thread-fetch query (there is no single-email GET
    // endpoint to fetch just this draft by id) — it does not mean "the
    // reader is viewing this thread". That piggyback has one accepted,
    // documented rough edge: the read-only reader can flash briefly in the
    // background while the thread query resolves, just before the composer
    // overlay mounts on top of it. removeComposeParam() below clears
    // `thread` again on close so it doesn't linger afterward.
    if (email.keywords.$draft) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("thread", email.threadId);
        next.set("compose", `draft:${email.id}`);
        return next;
      });
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("thread", email.threadId);
      return next;
    });
  }

  function handleCompose() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("compose", "new");
      return next;
    });
  }

  function handleArchived(email: EmailSummary) {
    if (email.threadId === threadParam) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("thread");
        return next;
      });
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!isPlainShortcut(event)) return;
      if (event.key === "c") {
        event.preventDefault();
        // CLARO-10: without identities the composer can't resolve a draft
        // (resolveComposeDraft returns null), so "c" silently did nothing —
        // now it surfaces the same hint the disabled Redactar button shows.
        if (!hasIdentities) {
          showToast(t("composer.noIdentitiesHint"));
          return;
        }
        handleCompose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasIdentities]);

  function removeComposeParam() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("compose");
      // Editing a draft sets `thread` only as a piggyback on the existing
      // thread-fetch query (see handleSelectMessage above), never because the
      // reader was actually being viewed — clear it too on close (Cancel or
      // after a successful send) so the reader doesn't keep showing that
      // thread (now stale: sent-and-trashed, or just abandoned) once the
      // composer is gone.
      if (composeMode === "draft") {
        next.delete("thread");
      }
      return next;
    });
  }

  function handleLabels(labels: string[]) {
    setAvailableLabels((prev) => {
      const merged = Array.from(new Set([...prev, ...labels])).sort();
      if (merged.length === prev.length && merged.every((label, i) => label === prev[i])) {
        return prev;
      }
      return merged;
    });
  }

  function resolveComposeDraft(): ComposerDraft | null {
    if (!composeParam) return null;
    const identities = identitiesQuery.data;
    if (!identities) return null;

    if (composeParam === "new") return emptyDraft(identities);
    if (!composeMatch) return null;
    if (composeThreadQuery.isLoading) return null;

    const email = composeThreadQuery.data?.emails.find(
      (candidate) => candidate.id === composeEmailId,
    );
    if (!email) return emptyDraft(identities);
    if (composeMode === "forward") return forwardDraft(email, identities);
    if (composeMode === "draft") return buildEditDraft(email, identities);
    return replyDraft(email, identities, composeMode === "reply-all");
  }

  const composeDraft = resolveComposeDraft();

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar
        mailboxes={mailboxes}
        selectedMailboxId={sidebarSelectedMailboxId}
        onSelectMailbox={handleSelectMailbox}
        starredSelected={starredParam}
        onSelectStarred={handleSelectStarred}
        groups={groups}
        selectedGroup={groupParam}
        onSelectGroup={handleSelectGroup}
        labels={availableLabels}
        selectedLabel={labelParam}
        onSelectLabel={handleSelectLabel}
        onCompose={handleCompose}
        composeDisabled={!hasIdentities}
        customLabels={customLabels}
        onCreateLabel={(label) => createLabelMutation.mutate(label)}
        onDeleteLabel={(slug) => deleteLabelMutation.mutate(slug)}
      />
      <section
        aria-label={t("mail.listRegion")}
        style={{ "--list-w": `${listWidth}px` } as CSSProperties}
        className={`${
          threadParam ? "hidden lg:flex" : "flex"
        } min-w-[280px] flex-1 flex-col overflow-y-auto overflow-x-hidden bg-panel lg:w-[var(--list-w)] lg:min-w-0 lg:flex-none`}
      >
        {otherMailboxError && (
          <p role="alert" className="p-4 text-sm text-warn">
            {t(mailErrorKey(mailboxesQuery.error))}
          </p>
        )}
        {unlinkedMailbox && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted">
            <div className="opacity-60">
              <CefiroLogo size={52} />
            </div>
            <p className="text-[15px] font-semibold text-ink">{t("mail.unlinked.title")}</p>
            <p className="max-w-[260px] text-[13px] text-muted">
              {t(isAdmin ? "mail.unlinked.descriptionAdmin" : "mail.unlinked.descriptionEmployee")}
            </p>
            {isAdmin ? (
              <Link
                to="/admin"
                className="mt-1 flex h-9 items-center justify-center rounded-[10px] bg-accent px-4 text-[13px] font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
              >
                {t("mail.unlinked.cta")}
              </Link>
            ) : (
              <p className="text-[12px] text-muted">{t("mail.unlinked.hint")}</p>
            )}
          </div>
        )}
        {!starredParam && groupAddresses.length > 0 && (
          <label className="flex h-[38px] w-full items-center gap-[11px] border-b border-line px-3 text-sm text-muted transition hover:bg-hover">
            <input
              type="checkbox"
              checked={preferences?.groupMailInMainInbox ?? false}
              onChange={(event) => toggleGroupMailInInboxMutation.mutate(event.target.checked)}
            />
            {t("groups.showInInbox")}
          </label>
        )}
        {!mailboxesQuery.isError && (starredParam || messageListMailboxId) && (
          <MessageList
            mailboxId={messageListMailboxId}
            hasKeyword={messageListHasKeyword}
            query={queryParam}
            selectedThreadId={threadParam}
            onSelect={handleSelectMessage}
            to={messageListTo}
            excludeTo={messageListExcludeTo}
            excludeMailboxId={starredParam ? archiveMailboxId ?? undefined : undefined}
            title={messageListTitle}
            onLabels={handleLabels}
            activeLabel={labelParam ?? undefined}
            onClearLabel={handleClearLabel}
            archiveMailboxId={archiveMailboxId}
            onArchived={handleArchived}
            customLabels={customLabels}
          />
        )}
      </section>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("mail.resizeList")}
        aria-valuemin={PANE_MIN_WIDTH}
        aria-valuemax={PANE_MAX_WIDTH}
        aria-valuenow={listWidth}
        tabIndex={0}
        onMouseDown={startDrag}
        onKeyDown={handleKeyDown}
        className="hidden w-1 shrink-0 cursor-col-resize bg-line transition-colors hover:bg-accent focus-visible:bg-accent lg:block"
      />
      <section
        aria-label={t("mail.readerRegion")}
        className={`${
          threadParam ? "block" : "hidden lg:block"
        } min-w-0 flex-1 overflow-y-auto overflow-x-hidden`}
      >
        {threadParam ? (
          <ThreadView threadId={threadParam} archiveMailboxId={archiveMailboxId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
            <div className="opacity-60">
              <CefiroLogo size={52} />
            </div>
            <p className="text-[15px] font-semibold text-ink">{t("mail.selectMessage")}</p>
            <p className="text-[13px] text-muted">
              {t("shortcuts.listHintPrefix")}{" "}
              <kbd className="rounded border border-line px-1.5 text-[11px]">j</kbd>{" "}
              {t("shortcuts.listHintMid")}{" "}
              <kbd className="rounded border border-line px-1.5 text-[11px]">k</kbd>{" "}
              {t("shortcuts.listHintSuffix")}
            </p>
          </div>
        )}
      </section>
      {composeDraft && (
        <Composer
          initial={composeDraft}
          onClose={removeComposeParam}
          trashMailboxId={trashMailboxId}
        />
      )}
    </div>
  );
}
