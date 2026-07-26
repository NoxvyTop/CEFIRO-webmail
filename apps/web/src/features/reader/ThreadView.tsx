import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import type { EmailAddress, EmailDetail, Identity } from "@webmail/shared";
import { MailApiError, destroyMessage, fetchInstanceSettings, fetchThread, updateMessage } from "../mailbox/api";
import { fetchPreferences } from "../mailbox/groups";
import { mailErrorKey, mailRetry } from "../mailbox/queryErrors";
import { fetchIdentities } from "../composer/api";
import { Avatar } from "../../app/ui/Avatar";
import { Button } from "../../app/ui/Button";
import { CefiroLoader } from "../../app/ui/CefiroLoader";
import { ArchiveIcon, ArrowLeftIcon, InboxIcon, ReplyIcon, StarFilledIcon, StarIcon, TagIcon, TrashIcon } from "../../app/ui/icons";
import { labelBackground, labelColor, labelDisplayName, userLabels } from "../../app/ui/labels";
import { formatRelativeTime } from "../../app/ui/relative-time";
import { isPlainShortcut } from "../../app/ui/shortcuts";
import { useToast } from "../../app/ui/toast";
import { AiSummaryCard } from "./AiSummaryCard";
import { AttachmentCard } from "./AttachmentCard";
import { EmailBody } from "./EmailBody";
import { extractReferencedCids } from "./sanitize";

interface ThreadViewProps {
  threadId: string;
  archiveMailboxId: string | null;
  inboxMailboxId: string | null;
  // GH #133: optional (defaults to null) so existing callers/tests that don't
  // care about Trash keep compiling unchanged — mirrors archiveMailboxId's
  // role, just for the trash-role mailbox instead.
  trashMailboxId?: string | null;
}

interface DeletePermanentlyConfirmDialogProps {
  subject: string;
  deleting: boolean;
  deleteError: string | null;
  onConfirm(): void;
  onCancel(): void;
}

// GH #133: shown before a message is permanently destroyed. Mirrors
// Composer.tsx's DiscardConfirmDialog and NewLabelModal.tsx's existing dialog
// precedent in this codebase — a full-screen bg-overlay backdrop,
// backdrop-click dismissal, focus moved in on open and restored on close, and
// its own Escape-to-dismiss effect scoped to this dialog only. Unlike
// discarding a draft, this action is irreversible, so the description always
// names the exact message being destroyed rather than a generic "this
// message" — and every dismissal path (Escape, backdrop click, Cancel)
// destroys nothing; only the explicit confirm button does.
function DeletePermanentlyConfirmDialog({
  subject, deleting, deleteError, onConfirm, onCancel,
}: DeletePermanentlyConfirmDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();

    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      role="alertdialog"
      aria-label={t("mail.deletePermanentlyConfirm.title")}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-6"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="flex w-full max-w-[360px] flex-col gap-4 rounded-[14px] border border-line bg-panel p-5 shadow-pop outline-none"
        style={{ animation: "popIn 0.18s ease" }}
      >
        <div>
          <h2 className="text-[14px] font-[650]">{t("mail.deletePermanentlyConfirm.title")}</h2>
          <p className="mt-1 text-[13px] text-muted">
            {t("mail.deletePermanentlyConfirm.description", { subject })}
          </p>
        </div>
        {deleteError && (
          <p role="alert" className="text-[12.5px] text-warn">
            {t(deleteError)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={deleting}>
            {t("mail.deletePermanentlyConfirm.cancel")}
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={deleting}>
            {deleting ? t("mail.deletePermanentlyConfirm.deleting") : t("mail.deletePermanentlyConfirm.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function addressLabel(address: EmailAddress | undefined) {
  if (!address) return "";
  return address.name || address.email;
}

// GH #90: the one-line stub shown for a collapsed (previous, already-read)
// message. bodyText is the primary source per the spec — falls back to the
// server-provided `preview` field (used elsewhere for the same purpose, see
// MessageList's conversation rows) for HTML-only messages that carry no
// bodyText at all, so a collapsed stub is never left blank.
function bodySnippet(email: EmailDetail, maxLength = 80): string {
  const source = (email.bodyText ?? email.preview ?? "").replace(/\s+/g, " ").trim();
  if (source.length <= maxLength) return source;
  return `${source.slice(0, maxLength).trimEnd()}…`;
}

// Gmail shows "Reply all" when there is at least one other recipient besides
// the account itself and the original sender — plain reply already goes to
// the sender, so reply-all is only meaningful once it would add someone.
// This mirrors reply.ts's replyDraft(): reply-all's cc is exactly
// dedupe(to+cc) minus the account's own identity and minus the sender's
// address, so the two modes are equivalent (and the button redundant)
// whenever that set is empty.
function hasReplyAllRecipient(email: EmailDetail, identities: Identity[]): boolean {
  const ownEmails = new Set(identities.map((identity) => identity.email.trim().toLowerCase()));
  const senderEmail = email.from[0]?.email.trim().toLowerCase();
  const others = new Set<string>();
  for (const address of [...email.to, ...email.cc]) {
    const key = address.email.trim().toLowerCase();
    if (ownEmails.has(key)) continue;
    if (senderEmail && key === senderEmail) continue;
    others.add(key);
  }
  return others.size >= 1;
}

export function ThreadView({ threadId, archiveMailboxId, inboxMailboxId, trashMailboxId = null }: ThreadViewProps) {
  const { t, i18n } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const threadQuery = useQuery({
    queryKey: ["mail", "thread", threadId],
    queryFn: () => fetchThread(threadId),
    retry: mailRetry,
  });

  // Used to detect messages the account itself sent (from === one of our
  // identities) so the sender block can show "Para: <recipients>" instead of
  // the inbox "para mí y el equipo" framing — correct regardless of which
  // mailbox/folder the thread is being viewed from.
  const identitiesQuery = useQuery({
    queryKey: ["mail", "identities"],
    queryFn: fetchIdentities,
  });
  const identities = identitiesQuery.data ?? [];

  // Powers custom label colors/names in the subject chips and the label-apply
  // menu below — shares the ["mail","preferences"] cache key with MailPage's
  // own preferencesQuery, so this is a no-op refetch in the common case.
  const preferencesQuery = useQuery({
    queryKey: ["mail", "preferences"],
    queryFn: fetchPreferences,
  });

  // Instance-level branding toggle (GH #86, admin console "Ajustes"): off
  // by default so a fresh instance shows no footer until an admin enables
  // it. Non-sensitive, so it's read from the public /api/instance endpoint.
  const instanceQuery = useQuery({
    queryKey: ["instance"],
    queryFn: fetchInstanceSettings,
  });
  const sentWithFooter = instanceQuery.data?.sentWithFooter ?? false;
  const customLabels = preferencesQuery.data?.customLabels ?? [];
  // GH #102: only the user's own custom labels are toggleable from this
  // menu — there is no more canonical/seeded registry, so a fresh user with
  // no custom labels sees an empty menu (the empty-state hint below) instead
  // of 4 names they never created. An arbitrary keyword applied by some
  // other client still shows read-only as a subject-line chip (userLabels()
  // below), it just isn't offered as a checkbox here.
  const applyLabelSlugs = customLabels.map((custom) => custom.slug);

  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  // GH #93: thread-actions-bar has overflow-x-hidden, and per the CSS spec a
  // non-"visible" value on one overflow axis forces the other axis to
  // compute as "auto" too — so overflow-y clips right along with it. That
  // clipped the apply-menu, which opens below the button. The menu is
  // rendered in a document.body portal (see below) so it escapes the bar's
  // overflow instead of trying to fight it. labelButtonRef is the trigger
  // (used for both the click-outside check and computing the portal's
  // position); labelMenuRef now refers to the portaled menu element itself
  // so click-outside can still recognize a click inside it as "inside".
  const labelButtonRef = useRef<HTMLButtonElement>(null);
  const labelMenuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);

  function toggleLabelMenu() {
    setLabelMenuOpen((open) => {
      const next = !open;
      if (next) {
        const rect = labelButtonRef.current?.getBoundingClientRect();
        if (rect) setMenuPosition({ top: rect.bottom + 8, left: rect.left });
      }
      return next;
    });
  }

  useEffect(() => {
    if (!labelMenuOpen) return;
    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      const insideButton = labelButtonRef.current?.contains(target) ?? false;
      const insideMenu = labelMenuRef.current?.contains(target) ?? false;
      if (!insideButton && !insideMenu) {
        setLabelMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setLabelMenuOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [labelMenuOpen]);

  // The portal escapes the action bar's layout, so its fixed position can't
  // reflow with the trigger on scroll/resize — closing on either is a
  // deliberate simplification over tracking the button's position live.
  useEffect(() => {
    if (!labelMenuOpen) return;
    function closeOnViewportChange() {
      setLabelMenuOpen(false);
    }
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [labelMenuOpen]);

  const archiveMutation = useMutation({
    mutationFn: (email: EmailDetail) => {
      if (!archiveMailboxId) throw new Error("no archive mailbox");
      return updateMessage(email.id, { mailboxIds: { [archiveMailboxId]: true } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail"] });
      showToast(`${t("mail.archived")} · ${t("mail.archivedHint")}`);
      backToList();
    },
  });

  // Inverse of archiveMutation: moves the email back into Recibidos. Same
  // single-mailbox move (JMAP mailboxIds is a full set, so this drops the
  // archive membership and adds the inbox), same post-success flow.
  const unarchiveMutation = useMutation({
    mutationFn: (email: EmailDetail) => {
      if (!inboxMailboxId) throw new Error("no inbox mailbox");
      return updateMessage(email.id, { mailboxIds: { [inboxMailboxId]: true } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail"] });
      showToast(t("mail.unarchived"));
      backToList();
    },
  });

  // GH #133: Delete moves the last email to Trash — the same single-mailbox
  // move archiveMutation/unarchiveMutation above already use (JMAP
  // mailboxIds is a full-set replace). Recoverable, so it needs no
  // confirmation — just feedback, mirroring archiveMutation's toast.
  const deleteMutation = useMutation({
    mutationFn: (email: EmailDetail) => {
      if (!trashMailboxId) throw new Error("no trash mailbox");
      return updateMessage(email.id, { mailboxIds: { [trashMailboxId]: true } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail"] });
      showToast(t("mail.deleted"));
      backToList();
    },
  });

  const [deletePermanentlyConfirmOpen, setDeletePermanentlyConfirmOpen] = useState(false);
  const [destroyError, setDestroyError] = useState<string | null>(null);

  // GH #133: permanently destroys the last email. Irreversible, so this is
  // only ever invoked from the explicit confirm button inside
  // DeletePermanentlyConfirmDialog below — never directly from the action
  // bar click.
  const destroyMutation = useMutation({
    mutationFn: (email: EmailDetail) => destroyMessage(email.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail"] });
      setDeletePermanentlyConfirmOpen(false);
      setDestroyError(null);
      showToast(t("mail.deletedPermanently"));
      backToList();
    },
    onError: (err) => {
      const error = err instanceof MailApiError ? `mail.errors.${err.code || "generic"}` : "mail.errors.generic";
      setDestroyError(error);
    },
  });

  function handleCancelDeletePermanently() {
    setDeletePermanentlyConfirmOpen(false);
    setDestroyError(null);
  }

  const starMutation = useMutation({
    mutationFn: ({ email, starred }: { email: EmailDetail; starred: boolean }) =>
      updateMessage(email.id, { keywords: { $flagged: starred } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail", "thread", threadId] });
      queryClient.invalidateQueries({ queryKey: ["mail", "messages"] });
    },
  });

  // Mirrors starMutation's shape: toggles a single JMAP keyword on the last
  // email, the same pattern the star affordance already uses.
  const keywordMutation = useMutation({
    mutationFn: ({ email, label, checked }: { email: EmailDetail; label: string; checked: boolean }) =>
      updateMessage(email.id, { keywords: { [label]: checked } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail", "thread", threadId] });
      queryClient.invalidateQueries({ queryKey: ["mail", "messages"] });
    },
  });

  function openCompose(param: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("compose", param);
      return next;
    });
  }

  function backToList() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("thread");
      return next;
    });
  }

  const emails = threadQuery.data?.emails ?? [];
  const lastEmail = emails[emails.length - 1];

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!isPlainShortcut(event)) return;
      if (!lastEmail) return;
      if (event.key === "r") {
        event.preventDefault();
        openCompose(`reply:${lastEmail.id}`);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEmail]);

  // GH #90: previous, already-read messages collapse into one-line stubs;
  // the newest message and any still-unread message stay expanded. This is
  // a one-time snapshot taken when the thread's messages first load — a Set
  // of expanded ids. It's deliberately NOT recomputed on every refetch
  // (star/label/archive mutations all invalidate and refetch this same
  // thread query): once the user has changed a message's expand state, a
  // later refetch must not reset it. The ref guards that — it only
  // (re)seeds the set the first time a given threadId's data arrives, so
  // switching to a different thread does get a fresh snapshot.
  const initializedThreadIdRef = useRef<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const currentEmails = threadQuery.data?.emails;
    if (!currentEmails || currentEmails.length === 0) return;
    if (initializedThreadIdRef.current === threadId) return;

    const newest = currentEmails[currentEmails.length - 1];
    const initial = new Set<string>();
    for (const email of currentEmails) {
      if (email.id === newest?.id || !email.keywords.$seen) initial.add(email.id);
    }
    setExpandedIds(initial);
    initializedThreadIdRef.current = threadId;
  }, [threadQuery.data, threadId]);

  // GH #119: a real toggle — clicking a collapsed stub expands it (GH #90)
  // and clicking an expanded message's header collapses it again. The
  // newest message starts expanded purely because the seeding effect above
  // put its id in the initial set, not because of any render-time force —
  // see the `isExpanded` check below — so it can be collapsed too.
  function toggleMessage(emailId: string) {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(emailId)) {
        next.delete(emailId);
      } else {
        next.add(emailId);
      }
      return next;
    });
  }

  if (threadQuery.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-warn">
        {t(mailErrorKey(threadQuery.error))}
      </p>
    );
  }

  // GH #94: branded loading state, mounted on top of the thread query's
  // already-existing pending state — no data-flow change, this only decides
  // what renders while `threadQuery` has no data yet. Once the query settles
  // (success or error) without ever having produced a `lastEmail` — e.g. a
  // thread that genuinely has no messages — the reader stays blank, same as
  // before this change.
  if (!lastEmail && threadQuery.isLoading) {
    return (
      <div data-testid="thread-loading" className="flex h-full items-center justify-center">
        <CefiroLoader size={56} label />
      </div>
    );
  }

  if (!lastEmail) return null;

  const isOnlyInArchive =
    archiveMailboxId !== null &&
    lastEmail.mailboxIds.length === 1 &&
    lastEmail.mailboxIds[0] === archiveMailboxId;
  const showArchive = archiveMailboxId !== null && !isOnlyInArchive;
  // Mutually exclusive with showArchive: only an archived email offers the way
  // back to Recibidos, and only when we know which mailbox that is.
  const showUnarchive = isOnlyInArchive && inboxMailboxId !== null;

  // GH #133: same "only in one mailbox" shape as isOnlyInArchive above, for
  // Trash. Delete moves a message INTO Trash — meaningless once it's already
  // there, so the two actions are mutually exclusive, mirroring how
  // showArchive/showUnarchive never both show. Delete permanently is offered
  // ONLY while genuinely viewing Trash: a destroy control anywhere else would
  // be a trap the user could hit on an ordinary message by mistake.
  const isOnlyInTrash =
    trashMailboxId !== null &&
    lastEmail.mailboxIds.length === 1 &&
    lastEmail.mailboxIds[0] === trashMailboxId;
  const showDelete = trashMailboxId !== null && !isOnlyInTrash;
  const showDeletePermanently = isOnlyInTrash;

  const starred = Boolean(lastEmail.keywords.$flagged);
  const showReplyAll = hasReplyAllRecipient(lastEmail, identities);

  // GH #118: render newest-first (top to bottom). `emails` itself keeps the
  // query's original oldest-to-newest order — the keyboard shortcut, the
  // expand-state seeding effect, and `lastEmail` above all depend on that
  // order, so only this display copy is reversed.
  const displayEmails = [...emails].reverse();

  const actionButtonBaseClass =
    "flex h-8 shrink-0 items-center gap-[7px] whitespace-nowrap rounded-lg px-3 text-[13px] transition hover:bg-hover";
  const actionButtonClass = `${actionButtonBaseClass} text-ink`;

  return (
    <div className="flex h-full flex-col">
      <div
        data-testid="thread-actions-bar"
        className="flex h-[52px] shrink-0 items-center gap-[6px] overflow-x-hidden border-b border-line px-[22px]"
      >
        <button
          type="button"
          onClick={backToList}
          aria-label={t("mail.backToList")}
          className={`${actionButtonClass} px-2 lg:hidden`}
        >
          <ArrowLeftIcon />
        </button>
        {showArchive && (
          <button
            type="button"
            onClick={() => archiveMutation.mutate(lastEmail)}
            className={actionButtonClass}
          >
            <ArchiveIcon size={15} />
            {t("mail.archive")}
          </button>
        )}
        {showUnarchive && (
          <button
            type="button"
            onClick={() => unarchiveMutation.mutate(lastEmail)}
            className={actionButtonClass}
          >
            <InboxIcon size={15} />
            {t("mail.unarchive")}
          </button>
        )}
        {showDelete && (
          <button
            type="button"
            onClick={() => deleteMutation.mutate(lastEmail)}
            className={actionButtonClass}
          >
            <TrashIcon size={15} />
            {t("mail.delete")}
          </button>
        )}
        {showDeletePermanently && (
          <button
            type="button"
            onClick={() => setDeletePermanentlyConfirmOpen(true)}
            className={actionButtonClass}
          >
            <TrashIcon size={15} />
            {t("mail.deletePermanently")}
          </button>
        )}
        <button
          type="button"
          aria-label={t(starred ? "mail.unstar" : "mail.star")}
          onClick={() => starMutation.mutate({ email: lastEmail, starred: !starred })}
          className={`${actionButtonBaseClass} ${starred ? "text-star" : "text-ink"}`}
        >
          {starred ? <StarFilledIcon size={15} /> : <StarIcon size={15} />}
          {t(starred ? "mail.unstar" : "mail.star")}
        </button>
        <button
          type="button"
          onClick={() => openCompose(`reply:${lastEmail.id}`)}
          className={actionButtonClass}
        >
          <ReplyIcon size={15} />
          {t("composer.reply")}
        </button>
        {showReplyAll && (
          <button
            type="button"
            onClick={() => openCompose(`reply-all:${lastEmail.id}`)}
            className={actionButtonClass}
          >
            {t("composer.replyAll")}
          </button>
        )}
        <button
          type="button"
          onClick={() => openCompose(`forward:${lastEmail.id}`)}
          className={actionButtonClass}
        >
          {t("composer.forward")}
        </button>
        <button
          ref={labelButtonRef}
          type="button"
          aria-label={t("mail.labels")}
          aria-haspopup="menu"
          aria-expanded={labelMenuOpen}
          onClick={toggleLabelMenu}
          className={actionButtonClass}
        >
          <TagIcon size={15} />
          {t("mail.labels")}
        </button>
        {labelMenuOpen && menuPosition && createPortal(
          <div
            ref={labelMenuRef}
            role="menu"
            style={{ position: "fixed", top: menuPosition.top, left: menuPosition.left }}
            className="z-50 flex min-w-[190px] flex-col rounded-[12px] border border-line bg-panel py-1 shadow-pop"
          >
            {applyLabelSlugs.length === 0 ? (
              <p className="px-3 py-2.5 text-[12.5px] text-muted">{t("mail.noLabelsToApply")}</p>
            ) : (
              applyLabelSlugs.map((slug) => {
                const checked = Boolean(lastEmail.keywords[slug]);
                return (
                  <button
                    key={slug}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    onClick={() => keywordMutation.mutate({ email: lastEmail, label: slug, checked: !checked })}
                    className={`flex h-9 w-full items-center gap-2 px-3 text-left text-sm hover:bg-hover ${
                      checked ? "bg-sel font-[650]" : "text-ink"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-[9px] w-[9px] shrink-0 rounded-[3px]"
                      style={{ background: labelColor(slug, customLabels) }}
                    />
                    <span className="min-w-0 flex-1 truncate capitalize">
                      {labelDisplayName(slug, customLabels)}
                    </span>
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
        <span className="ml-auto hidden min-w-0 truncate text-xs text-muted md:block">{t("shortcuts.hint")}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[780px] px-5 pb-[60px] pt-[30px] md:px-10" style={{ animation: "fadeUp 0.25s ease-out" }}>
          <div className="mb-[14px] flex flex-wrap items-center gap-2.5">
            <h2 className="text-[26px] font-[650] leading-[1.25] tracking-[-0.01em]">
              {lastEmail.subject || t("mail.noSubject")}
            </h2>
            {userLabels(lastEmail.keywords).map((label) => (
              <span
                key={label}
                className="rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold"
                style={{ color: labelColor(label, customLabels), background: labelBackground(label, customLabels) }}
              >
                {labelDisplayName(label, customLabels)}
              </span>
            ))}
          </div>
          {displayEmails.map((email) => {
            const sender = email.from[0];
            const isNewest = email.id === lastEmail.id;
            // GH #90: previous, already-read messages collapse into a
            // one-line stub. A single-message thread is always fully
            // expanded — there's nothing to collapse "away from". GH #119:
            // the newest message is no longer forced open here — it starts
            // expanded via the seeding effect above but, like any other
            // message, can be collapsed and re-expanded by the user.
            const isExpanded = emails.length === 1 || expandedIds.has(email.id);
            // GH #119: only a message that could actually collapse "into"
            // something gets the collapse affordance on its header — a
            // single-message thread has nothing else to show.
            const collapsible = emails.length > 1;
            const dateLabel = formatRelativeTime(email.receivedAt, {
              yesterdayLabel: t("mail.yesterday"),
              locale: i18n.language,
            });

            if (!isExpanded) {
              return (
                <article key={email.id} className="mt-6 border-b border-line pb-6 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => toggleMessage(email.id)}
                    aria-expanded={isExpanded}
                    aria-label={t("mail.expandMessage", { sender: addressLabel(sender) })}
                    className="flex w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition hover:bg-hover"
                  >
                    <Avatar name={sender?.name ?? null} email={sender?.email ?? "?"} size={28} />
                    <span className="min-w-0 flex-1 truncate text-[13.5px]">
                      <span className="font-semibold text-ink">{addressLabel(sender)}</span>
                      <span className="text-muted"> — {bodySnippet(email)}</span>
                    </span>
                    <span className="shrink-0 text-[12px] text-muted">{dateLabel}</span>
                  </button>
                </article>
              );
            }

            const toCcLabel = [...email.to, ...email.cc].map(addressLabel).filter(Boolean).join(", ");
            // A message counts as "sent" when its `from` matches one of the
            // account's own identities — this stays correct no matter which
            // mailbox/folder the thread is currently being viewed from.
            const isSentByMe = Boolean(
              sender && identities.some((identity) => identity.email.toLowerCase() === sender.email.toLowerCase()),
            );

            // Attachments referenced inline via <img src="cid:..."> in the body
            // render inside EmailBody itself (see the cidMap it builds from
            // `attachments`) — they'd be a duplicate if also shown as a
            // downloadable chip below, so they're hidden from the chip list
            // here (Gmail behavior). Attachments not referenced by any cid:
            // image — including images sent as real attachments — stay visible.
            const referencedCids = extractReferencedCids(email.bodyHtml);
            const visibleAttachments = email.attachments.filter(
              (attachment) => !(attachment.cid && referencedCids.has(attachment.cid)),
            );

            // GH #119: the header of an expanded, collapsible message is
            // itself the collapse control — clicking it re-collapses the
            // message into the GH #90 stub. Built once so both the button
            // and the plain-div fallback (single-message thread) render
            // identical content. The button's content model is phrasing
            // content only, so — like the GH #90 stub above — these are
            // `<span>`s with an explicit block display rather than `<div>`s,
            // which would be invalid inside a `<button>`.
            const senderHeaderContent = (
              <>
                <Avatar name={sender?.name ?? null} email={sender?.email ?? "?"} size={42} />
                <span className="block min-w-0 flex-1">
                  <span className="block text-[14.5px] font-semibold">{addressLabel(sender)}</span>
                  {toCcLabel && (
                    <span className="block truncate text-[12.5px] text-muted">
                      {isSentByMe ? `${t("mail.sentTo")} ${toCcLabel}` : `${sender?.email} · ${t("mail.toMeAndTeam")}`}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[12.5px] text-muted">{dateLabel}</span>
              </>
            );

            return (
              <article
                key={email.id}
                // GH #92: the newest (active) message gets a subtle elevated-card
                // treatment — a real border, the panel surface, and shadow-card
                // — so it visually stands out from the collapsed stubs / older
                // messages below it (GH #118 moved it to the top), in both the
                // light and night themes.
                className={
                  isNewest
                    ? "mt-6 rounded-[14px] border border-line bg-panel p-5 shadow-card"
                    : "mt-6 border-b border-line pb-6"
                }
              >
                {collapsible ? (
                  <button
                    type="button"
                    onClick={() => toggleMessage(email.id)}
                    aria-expanded={isExpanded}
                    aria-label={t("mail.collapseMessage", { sender: addressLabel(sender) })}
                    className="flex w-full items-center gap-3 border-b border-line pb-5 mb-[22px] text-left transition hover:bg-hover"
                  >
                    {senderHeaderContent}
                  </button>
                ) : (
                  <div className="flex items-center gap-3 border-b border-line pb-5 mb-[22px]">
                    {senderHeaderContent}
                  </div>
                )}
                {isNewest && (
                  <AiSummaryCard messageId={email.id} threadId={threadId} messageCount={emails.length} />
                )}
                <div className="mt-3 text-[15px] leading-[1.65]">
                  <EmailBody bodyHtml={email.bodyHtml} bodyText={email.bodyText} attachments={email.attachments} />
                </div>
                {visibleAttachments.length > 0 && (
                  <div className="mt-5">
                    <p className="mb-2 text-[12.5px] font-semibold text-muted">
                      {t("attachments.count", { count: visibleAttachments.length })}
                    </p>
                    <div className="flex flex-wrap gap-3">
                      {visibleAttachments.map((attachment) => (
                        <AttachmentCard key={attachment.blobId} attachment={attachment} />
                      ))}
                    </div>
                  </div>
                )}
                {isNewest && (
                  <>
                    <div className="mt-5 border-t border-line pt-4">
                      <p className="text-[13.5px] font-semibold">{addressLabel(sender)}</p>
                      {sentWithFooter && (
                        <p
                          data-testid="sent-with-footer"
                          className="mt-4 flex items-center gap-2 text-[11.5px] text-muted"
                        >
                          <svg width="14" height="14" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true" className="text-accent">
                            <path d="M9 15h13a3.6 3.6 0 1 0-3.6-6.3" />
                            <path d="M7 21h19a3.6 3.6 0 1 1 3.6 6.3" />
                            <path d="M9 27h10" />
                          </svg>
                          <span>
                            {t("app.sentWith")}{" "}
                            <span className="font-bold tracking-[0.14em] text-accent-text">CÉFIRO</span> ·{" "}
                            {t("app.sealMotto")}
                          </span>
                        </p>
                      )}
                    </div>
                    <div data-testid="thread-footer-actions" className="mt-[26px] flex gap-2.5">
                      <button
                        type="button"
                        onClick={() => openCompose(`reply:${lastEmail.id}`)}
                        className="flex h-[38px] items-center gap-2 rounded-[10px] border border-line bg-panel px-[18px] text-[13.5px] font-semibold text-ink transition hover:bg-hover"
                      >
                        <ReplyIcon size={14} />
                        {t("composer.reply")}
                      </button>
                      {showReplyAll && (
                        <button
                          type="button"
                          onClick={() => openCompose(`reply-all:${lastEmail.id}`)}
                          className="flex h-[38px] items-center gap-2 rounded-[10px] border border-line bg-panel px-[18px] text-[13.5px] font-semibold text-ink transition hover:bg-hover"
                        >
                          {t("composer.replyAll")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openCompose(`forward:${lastEmail.id}`)}
                        className="flex h-[38px] items-center gap-2 rounded-[10px] border border-line bg-panel px-[18px] text-[13.5px] font-semibold text-ink transition hover:bg-hover"
                      >
                        {t("composer.forward")}
                      </button>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </div>
      {deletePermanentlyConfirmOpen && (
        <DeletePermanentlyConfirmDialog
          subject={lastEmail.subject || t("mail.noSubject")}
          deleting={destroyMutation.isPending}
          deleteError={destroyError}
          onConfirm={() => destroyMutation.mutate(lastEmail)}
          onCancel={handleCancelDeletePermanently}
        />
      )}
    </div>
  );
}
