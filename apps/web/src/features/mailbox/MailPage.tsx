import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { CustomLabel, EmailSummary } from "@webmail/shared";
import {
  ACTIVE_ACCOUNT_PARAM, SHARED_ACCOUNTS_QUERY_KEY, fetchMailboxes, fetchSharedAccounts, fetchThread,
} from "./api";
import {
  deriveGroupAddresses, fetchPreferences, mergeGroupEntries, updatePreferences, type GroupEntry,
} from "./groups";
import { isUnlinkedMailboxError, mailErrorKey, mailRetry } from "./queryErrors";
import { MessageList } from "./MessageList";
import { SharedMailboxBanner } from "./SharedMailboxBanner";
import { Sidebar } from "./Sidebar";
import { useMailEvents } from "./useMailEvents";
import { useUnreadBadge } from "./useUnreadBadge";
import { ThreadView } from "../reader/ThreadView";
import { CefiroLogo } from "../../app/ui/CefiroLogo";
import { MenuIcon } from "../../app/ui/icons";
import { folderName } from "../../app/ui/folders";
import { useToast } from "../../app/ui/toast";
import { fetchIdentities } from "../composer/api";
import { buildEditDraft, emptyDraft, forwardDraft, replyDraft, type ComposerDraft } from "../composer/reply";
import { isPlainShortcut } from "../../app/ui/shortcuts";
import { useAuth } from "../auth/useAuth";
import { PANE_MIN_WIDTH, useResizablePane } from "../../app/ui/useResizablePane";

// The composer pulls in TipTap (the editor is by far the heaviest dependency in
// this view), so it's split into its own chunk and only fetched when the user
// actually opens it — keeping TipTap out of the first paint of the mail list.
const Composer = lazy(() =>
  import("../composer/Composer").then((module) => ({ default: module.Composer })),
);

export function MailPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { width: listWidth, maxWidth: paneMaxWidth, startDrag, handleKeyDown } = useResizablePane();
  const isAdmin = user?.role === "admin";

  // GH #274: the stream may refuse this tab's handshake with 429 too_many_streams
  // (the 8/user cap of #241). When it does, the hook stops the silent retry loop
  // and reports it here so the tab can say live updates are limited rather than
  // spinning forever with no sign to the user.
  // GH #342: `streamOpen` is false for every reason live updates aren't
  // flowing right now (reconnecting, limited, offline) — used below as the
  // single signal for whether the mailboxes/messages queries need to fall
  // back to polling.
  const { liveUpdatesLimited, streamOpen } = useMailEvents(true);
  const pollWhileStreamDown = !streamOpen;
  // GH #338: the unread count in the tab title and on the favicon. Mounted here
  // rather than in the shell because this is the screen that holds the live
  // stream — and keeping the PERSONAL mailboxes query active is also what lets
  // an arrival be detected while a shared mailbox is the one on screen.
  useUnreadBadge();

  const mailboxParam = searchParams.get("mailbox");
  // GH #13/#50: the active shared mailbox (the account selector in the header
  // sets it). Undefined = personal, so the whole view stays exactly as before
  // when no shared mailbox is selected.
  const accountParam = searchParams.get(ACTIVE_ACCOUNT_PARAM) ?? undefined;
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
  // GH #177: below `lg` the sidebar is an off-canvas drawer instead of a
  // fixed 230px column that squeezed the mail list to truncated slivers at
  // narrow widths. Closed by default; the `lg:hidden` hamburger opens it.
  const [navOpen, setNavOpen] = useState(false);

  const mailboxesQuery = useQuery({
    queryKey: ["mail", "mailboxes", accountParam ?? null],
    queryFn: () => fetchMailboxes(accountParam),
    retry: mailRetry,
    // GH #342: same polling fallback as MessageList's messages query — see
    // its comment for why.
    refetchInterval: pollWhileStreamDown ? 60_000 : undefined,
    refetchIntervalInBackground: false,
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

  // #340: the shared mailboxes the member can open. The sidebar used to list a
  // group twice under the same name — once here as a send-as identity opening
  // the PERSONAL inbox filtered by recipient, and once on the "Buzones
  // compartidos" page opening the group's own account — and neither showed
  // unread, so a new message in the group's mailbox looked like it never
  // arrived ("0 correos" on the filtered view). One merged row now, and it
  // opens the group's own mailbox when there is one.
  const sharedAccountsQuery = useQuery({
    queryKey: SHARED_ACCOUNTS_QUERY_KEY,
    queryFn: fetchSharedAccounts,
    retry: mailRetry,
  });
  const sharedAccounts = useMemo(() => sharedAccountsQuery.data ?? [], [sharedAccountsQuery.data]);

  // #340: one light mailbox read per shared account, purely for the unread
  // count on its sidebar row. Deliberately the SAME query key the mail view
  // itself uses for that account (["mail","mailboxes",<accountId>]), so opening
  // the mailbox costs nothing extra and the SSE stream's ["mail","mailboxes"]
  // invalidation — which prefix-matches every account — keeps the counter live
  // without a second invalidation path (see useMailEvents.ts).
  const sharedMailboxQueries = useQueries({
    queries: sharedAccounts.map((account) => ({
      queryKey: ["mail", "mailboxes", account.id],
      queryFn: () => fetchMailboxes(account.id),
      retry: mailRetry,
    })),
  });

  // Plain derivation rather than a memo: useQueries hands back a fresh result
  // array on every render, so any dependency list over it would either be a lie
  // or recompute anyway — and merging a handful of groups is far cheaper than
  // the bookkeeping to avoid it.
  const groupEntries: GroupEntry[] = mergeGroupEntries(groups, sharedAccounts).map((entry) => {
    if (!entry.accountId) return entry;
    const index = sharedAccounts.findIndex((account) => account.id === entry.accountId);
    const inbox = sharedMailboxQueries[index]?.data?.find((box) => box.role === "inbox");
    return inbox ? { ...entry, unread: inbox.unreadEmails } : entry;
  });

  const composeThreadQuery = useQuery({
    queryKey: ["mail", "thread", threadParam ?? "", accountParam ?? null],
    queryFn: () => fetchThread(threadParam as string, accountParam),
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

  // GH #106: a label view — no explicit `mailbox` param, not starred, not
  // grouped — must span every folder instead of silently defaulting to
  // Inbox. That implicit Inbox default was the root of the
  // folder-then-label accidental intersection bug: `selectedMailboxId`
  // itself keeps its Inbox fallback (sidebar highlighting, the group-scoped
  // query and the "main inbox selected" checks below all still depend on
  // that default), so this is a separate derivation rather than a change to
  // `selectedMailboxId`. If `mailbox` IS present in the URL (an explicit
  // combination, e.g. loaded directly), that explicit choice is respected
  // and the view stays scoped to it, per design.
  const labelSpansFolders = Boolean(labelParam) && !mailboxParam && !starredParam && !groupParam;

  const messageListMailboxId = starredParam
    ? undefined
    : labelSpansFolders
      ? undefined
      : (groupParam ? inboxMailboxId : selectedMailboxId) ?? undefined;

  // GH #106: label views (see `labelSpansFolders` above) exclude Trash so
  // deleted mail doesn't leak into a label search spanning every folder.
  // Reuses the same single-value `excludeMailboxId` slot already used to
  // exclude Archive from the starred view — fetchMessages only accepts one
  // exclusion today. Follow-up: excluding Spam/Junk too would need
  // multi-mailbox exclude support (a list-shaped query param on the client
  // plus matching support in fetchMessages/the server's JMAP filter) — out
  // of scope for this change, so only Trash is excluded for now.
  const messageListExcludeMailboxId = starredParam
    ? archiveMailboxId ?? undefined
    : labelSpansFolders
      ? trashMailboxId ?? undefined
      : undefined;

  const messageListTo = starredParam ? undefined : (groupParam ?? undefined);

  const isMainInboxSelected =
    !starredParam && !groupParam && selectedMailboxId !== null && selectedMailboxId === inboxMailboxId;

  // #340: "the personal main inbox" — the only view the groupMailInMainInbox
  // preference governs. Without the account check it also matched the INBOX OF A
  // SHARED MAILBOX (same role, same fallback), where excluding the group's own
  // address hides exactly the mail that mailbox exists to hold, and where the
  // checkbox was offered over a list it has no bearing on.
  const isPersonalMainInboxSelected = isMainInboxSelected && !accountParam;

  const messageListExcludeTo =
    isPersonalMainInboxSelected &&
    preferences?.groupMailInMainInbox === false &&
    groupAddresses.length > 0
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
      // GH #106: selecting a folder replaces any active label view — without
      // this, the message list silently intersected the folder AND the
      // still-active label instead of just navigating to the folder.
      next.delete("label");
      return next;
    });
  }

  // #340: a group row is one destination now. When the member can reach the
  // group's OWN mailbox (a shared account in their JMAP session) that is what
  // opens — it is the source of truth, it holds the mail that actually arrived,
  // and it is the only one of the two views that can carry an unread count.
  // The `?group=` filter over the PERSONAL inbox stays as the fallback for a
  // group known only as a send-as identity, where there is no shared account to
  // open (see docs/design/shared-mailboxes.md: Stalwart does not deliver a copy
  // to each member, so that view is empty unless the copy opt-in put one there).
  function handleSelectGroup(group: GroupEntry) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("thread");
      next.delete("starred");
      next.delete("mailbox");
      next.delete("label");
      if (group.accountId) {
        next.set(ACTIVE_ACCOUNT_PARAM, group.accountId);
        next.delete("group");
        return next;
      }
      next.delete(ACTIVE_ACCOUNT_PARAM);
      next.set("group", group.address ?? group.label);
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
        // Toggle-off: returning to the default view needs nothing extra
        // cleared here — there is no new selection being made.
        next.delete("label");
      } else {
        next.set("label", label);
        // GH #106: selecting a label replaces the folder/starred/group view
        // (Gmail-style navigation) instead of intersecting with it — without
        // these, the message list silently combined the label with whatever
        // folder/starred/group was still active.
        next.delete("mailbox");
        next.delete("starred");
        next.delete("group");
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

  // GH #268: leaves the search and returns to the folder. The search box lives
  // in the app shell (App.tsx), so the list header carries its own clear
  // affordance — this drops `q` (and any open thread from a result) so the view
  // falls back to the folder/label it was scoped to.
  function handleClearSearch() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("q");
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

  // #340: the label rail accumulated every keyword ever seen, so the labels
  // discovered in the personal mailbox stayed on screen after switching to a
  // shared account that has none of them — a taxonomy leaking across mailboxes
  // that do not share one. Accumulation is still right WITHIN an account (the
  // list only ever reports the keywords of the pages it has loaded), so the
  // reset is scoped to the account changing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setAvailableLabels([]), [accountParam]);

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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* GH #177: narrow-viewport top bar carrying the hamburger that opens the
          sidebar drawer. Hidden at `lg`+, where the sidebar is a static column
          and needs no toggle. */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 lg:hidden">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label={t("mail.navMenu")}
          aria-expanded={navOpen}
          aria-controls="mailbox-nav"
          aria-haspopup="dialog"
          className="flex h-9 w-9 items-center justify-center rounded-[9px] text-ink transition hover:bg-hover"
        >
          <MenuIcon size={20} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <Sidebar
        mailboxes={mailboxes}
        selectedMailboxId={sidebarSelectedMailboxId}
        onSelectMailbox={handleSelectMailbox}
        starredSelected={starredParam}
        onSelectStarred={handleSelectStarred}
        groups={groupEntries}
        selectedGroup={groupParam}
        selectedAccountId={accountParam ?? null}
        onSelectGroup={handleSelectGroup}
        labels={availableLabels}
        selectedLabel={labelParam}
        onSelectLabel={handleSelectLabel}
        onCompose={handleCompose}
        onOpenSharedMailboxes={() => navigate("/shared")}
        composeDisabled={!hasIdentities}
        customLabels={customLabels}
        onCreateLabel={(label) => createLabelMutation.mutate(label)}
        onDeleteLabel={(slug) => deleteLabelMutation.mutate(slug)}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />
      <section
        aria-label={t("mail.listRegion")}
        style={{ "--list-w": `${listWidth}px` } as CSSProperties}
        className={`${
          threadParam ? "hidden lg:flex" : "flex"
        } min-w-[280px] flex-1 flex-col overflow-y-auto overflow-x-hidden bg-panel lg:w-[var(--list-w)] lg:min-w-0 lg:flex-none`}
      >
        {/* GH #13/#50 (G-4): the account selector that used to name the active
            shared mailbox in the top bar is gone; this read-only indicator names
            it inside the mail view instead, with a way back to the personal
            inbox. Renders nothing on the personal mailbox. */}
        <SharedMailboxBanner />
        {/* GH #274: this tab could not open a live stream (429 too_many_streams).
            A persistent, polite banner — not a toast that fades — because the
            limitation lasts until a stream frees up and the tab is reloaded. */}
        {liveUpdatesLimited && (
          <p
            role="status"
            className="shrink-0 border-b border-line bg-soft px-4 py-2 text-xs text-warn"
          >
            {t("mail.liveUpdatesLimited")}
          </p>
        )}
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
        {/* #340: this sat above every non-starred view without saying WHICH
            group it referred to, and read as a twin of the shared-mailbox opt-in
            ("Recibir copia de … en mi bandeja") which does something else
            entirely — that one asks the server to DELIVER copies, this one only
            filters what the main inbox shows. So it now names the groups, spells
            out that it delivers nothing, and only appears on the view it
            actually governs: the main inbox. */}
        {isPersonalMainInboxSelected && groupAddresses.length > 0 && (
          <label className="flex w-full items-start gap-[11px] border-b border-line px-3 py-2 text-sm text-muted transition hover:bg-hover">
            <input
              type="checkbox"
              className="mt-[3px] shrink-0"
              // The help line below is part of the <label>, so without an
              // explicit name the control would be announced as the whole
              // paragraph. Named by the sentence that states what it does.
              aria-label={t("groups.showInInbox", { groups: groupAddresses.join(", ") })}
              checked={preferences?.groupMailInMainInbox ?? false}
              onChange={(event) => toggleGroupMailInInboxMutation.mutate(event.target.checked)}
            />
            <span className="flex min-w-0 flex-col">
              <span>{t("groups.showInInbox", { groups: groupAddresses.join(", ") })}</span>
              <span className="text-[12px] text-muted">{t("groups.showInInboxHelp")}</span>
            </span>
          </label>
        )}
        {/* GH #106: a label view spanning folders deliberately leaves
            messageListMailboxId undefined (see labelSpansFolders above) —
            without labelSpansFolders in this guard the list never mounted
            at all for that case. */}
        {!mailboxesQuery.isError && (starredParam || messageListMailboxId || labelSpansFolders) && (
          <MessageList
            mailboxId={messageListMailboxId}
            hasKeyword={messageListHasKeyword}
            query={queryParam}
            selectedThreadId={threadParam}
            onSelect={handleSelectMessage}
            to={messageListTo}
            excludeTo={messageListExcludeTo}
            excludeMailboxId={messageListExcludeMailboxId}
            title={messageListTitle}
            onLabels={handleLabels}
            activeLabel={labelParam ?? undefined}
            onClearLabel={handleClearLabel}
            onClearSearch={handleClearSearch}
            archiveMailboxId={archiveMailboxId}
            onArchived={handleArchived}
            customLabels={customLabels}
            accountId={accountParam}
            pollWhileStreamDown={pollWhileStreamDown}
          />
        )}
      </section>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("mail.resizeList")}
        aria-valuemin={PANE_MIN_WIDTH}
        aria-valuemax={paneMaxWidth}
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
          <ThreadView
            threadId={threadParam}
            archiveMailboxId={archiveMailboxId}
            inboxMailboxId={inboxMailboxId}
            trashMailboxId={trashMailboxId}
            accountId={accountParam}
            // #343: the same mailbox the list is scoped to, so archiving or
            // deleting from the reader acts on the whole conversation as it
            // appears in that folder — undefined here (starred, a
            // folder-spanning label) means "no current mailbox".
            currentMailboxId={messageListMailboxId ?? null}
          />
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
        <Suspense fallback={null}>
          <Composer
            // GH #145: useComposer consumes `initial` at mount only — the
            // reducer seed plus every ref derived from it (the owned draft id,
            // the last-saved fingerprint). A `compose` param that changed under
            // a still-mounted Composer would therefore keep the previous
            // message's state, and the dangerous part of that state is the part
            // the user cannot see: stale inReplyTo/references would graft the
            // new reply onto an unrelated thread and disclose that thread's
            // Message-IDs to someone who was never in it.
            //
            // Keying on the param makes the whole class unreachable by
            // construction — a different compose target is a different
            // Composer. Remounting is safe for both draft mechanisms: the
            // outgoing instance's unmount flush (GH #176) persists its own
            // content against its own currentDraftIdRef, so the draft it owned
            // is superseded rather than duplicated, and the incoming instance
            // re-seeds every ref from its own `initial` (GH #178).
            key={composeParam}
            initial={composeDraft}
            onClose={removeComposeParam}
            trashMailboxId={trashMailboxId}
          />
        </Suspense>
      )}
      </div>
    </div>
  );
}
