import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import type { EmailAddress, EmailDetail, Identity } from "@webmail/shared";
import { MailApiError, destroyMessage, fetchInstanceSettings, fetchThread, updateMessage } from "../mailbox/api";
import { fetchPreferences } from "../mailbox/groups";
import { mailErrorKey, mailRetry } from "../mailbox/queryErrors";
import { EMAIL_QUERY_KEYS, MAILBOX_QUERY_KEYS } from "../mailbox/useMailEvents";
import { fetchIdentities } from "../composer/api";
import { replyRecipients } from "../composer/reply";
import { errorMessageKey } from "../../app/errorMessages";
import { Avatar } from "../../app/ui/Avatar";
import { Button } from "../../app/ui/Button";
import { CefiroLoader } from "../../app/ui/CefiroLoader";
import { ArchiveIcon, ArrowLeftIcon, InboxIcon, ReplyIcon, StarFilledIcon, StarIcon, TagIcon, TrashIcon } from "../../app/ui/icons";
import { labelBackground, labelColor, labelDisplayName, userLabels } from "../../app/ui/labels";
import { formatRelativeTime } from "../../app/ui/relative-time";
import { isPlainShortcut } from "../../app/ui/shortcuts";
import { useToast } from "../../app/ui/toast";
import { useFocusTrap } from "../../app/ui/useFocusTrap";
import { AiSummaryCard } from "./AiSummaryCard";
import { AttachmentCard } from "./AttachmentCard";
import { EmailBody, isSafeInlineImage } from "./EmailBody";
import { extractReferencedCids } from "./sanitize";
import { SenderAuthBadge } from "./SenderAuthBadge";

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
  // GH #158/#161: focus-in/Tab-cycling/restore-on-close now come from the
  // shared useFocusTrap primitive — this dialog used to move focus in and
  // restore it on close by hand, but never cycled Tab, so focus could walk
  // out of this still-visible confirmation into the background page (right
  // next to the irreversible destroy action it's guarding).
  const dialogRef = useFocusTrap<HTMLDivElement>(true);

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
      // GH #253: this one guards an irreversible destroy, which makes the gap
      // between "Tab is trapped" and "the screen reader can still read and
      // activate the page behind it" the worst place to have it.
      aria-modal="true"
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
// the account itself and whoever plain reply already addresses — reply-all
// is only meaningful once it would add someone plain reply doesn't already
// reach.
//
// GH #174: this used to be a hand-rolled predicate that claimed to mirror
// reply.ts's replyDraft() but actually diverged from it on any message
// carrying a Reply-To — it always excluded email.from[0], while replyDraft's
// "to" is replyTo when present, else from, and it matched against every
// identity while replyDraft picks exactly one. The two could show a button
// whose draft turns out identical to plain reply, or hide one that would
// genuinely have added a recipient. Rather than patch the predicate again
// (and risk a second drift), visibility now calls the exact same recipient
// computation the real draft is built from, so the two cannot disagree.
// It deliberately calls replyRecipients rather than replyDraft: the draft
// also builds a quoted body, which means a DOMParser parse and a DOMPurify
// pass over the whole message — far too much work to decide whether to
// paint a button, on every render.
function hasReplyAllRecipient(email: EmailDetail, identities: Identity[]): boolean {
  return replyRecipients(email, identities, true).cc.length > 0;
}

// GH #227: archiving, un-archiving, deleting and destroying all move (or
// remove) one email, so exactly three things can have changed: the listings it
// appears in, the thread it belongs to, and the unread/total counts of the
// mailboxes on either side of the move.
//
// These used to invalidate the whole ["mail"] namespace instead, which swept
// identities, preferences and signatures — none of which a mailbox move can
// touch — along with every page an infinite listing had already loaded. That is
// the same cost GH #167 removed from the SSE path; useMailEvents.ts documents
// it in full, and this reuses that module's own key sets so the two can't drift.
const MAILBOX_MOVE_INVALIDATION_KEYS = [...EMAIL_QUERY_KEYS, ...MAILBOX_QUERY_KEYS];

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

  // See MAILBOX_MOVE_INVALIDATION_KEYS above for why this is not one
  // invalidateQueries({ queryKey: ["mail"] }).
  function invalidateAfterMailboxMove() {
    for (const queryKey of MAILBOX_MOVE_INVALIDATION_KEYS) {
      queryClient.invalidateQueries({ queryKey });
    }
  }

  const archiveMutation = useMutation({
    mutationFn: (email: EmailDetail) => {
      if (!archiveMailboxId) throw new Error("no archive mailbox");
      return updateMessage(email.id, { mailboxIds: { [archiveMailboxId]: true } });
    },
    onSuccess: () => {
      invalidateAfterMailboxMove();
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
      invalidateAfterMailboxMove();
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
      invalidateAfterMailboxMove();
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
      invalidateAfterMailboxMove();
      setDeletePermanentlyConfirmOpen(false);
      setDestroyError(null);
      showToast(t("mail.deletedPermanently"));
      backToList();
    },
    onError: (err) => {
      // GH #215: this used to interpolate the raw server code into the key with
      // no existence check, so an unmapped one (jmap_error, stalwart_unavailable,
      // internal) was shown to the user as the literal key.
      setDestroyError(errorMessageKey("mail", err instanceof MailApiError ? err.code : null));
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
  // of expanded ids. It's deliberately NOT recomputed wholesale on every
  // refetch (star/label/archive mutations all invalidate and refetch this
  // same thread query, and so does every server-sent event via
  // useMailEvents' blanket ["mail"] invalidation): once the user has changed
  // an already-known message's expand state, a later refetch must not reset
  // it. initializedThreadIdRef guards the full reseed — it only happens the
  // first time a given threadId's data arrives, so switching to a different
  // thread does get a fresh snapshot.
  //
  // GH #162: that guard used to also block admitting genuinely NEW message
  // ids that arrive while the thread stays open (e.g. a reply landing via
  // the SSE-driven refetch above) — a message id never seen before for this
  // thread was simply never added to expandedIds, silently collapsing it
  // (and, since it's the newest message, taking the reply/reply-all/forward
  // footer and AI summary card down with it — both live inside the
  // isExpanded branch). knownEmailIdsRef tracks which ids have already been
  // accounted for (by the initial seed or a previous run of this effect) so
  // a later run can tell "new to this thread" apart from "already decided,
  // possibly by the user" and only ever ADD the former — an already-known
  // id's expand state, however it got there, is never touched again here.
  const initializedThreadIdRef = useRef<string | null>(null);
  const knownEmailIdsRef = useRef<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  // GH #275: cids (per email) of inline images that failed to load inside the
  // body. An inline cid image is normally hidden from the attachment chip list
  // (it renders in the body instead), but if its blob fetch fails it renders
  // as nothing AND had no chip — the attachment became unreachable. EmailBody
  // reports the failures up here so those attachments surface as downloadable
  // chips after all.
  const [failedInlineCids, setFailedInlineCids] = useState<Record<string, string[]>>({});

  function reportFailedInlineCids(emailId: string, cids: string[]) {
    setFailedInlineCids((previous) => {
      const existing = previous[emailId] ?? [];
      // Bail when unchanged so a repeated report (EmailBody re-runs its effect
      // whenever this component re-renders) can't loop re-renders.
      if (existing.length === cids.length && existing.every((cid) => cids.includes(cid))) {
        return previous;
      }
      return { ...previous, [emailId]: cids };
    });
  }

  useEffect(() => {
    const currentEmails = threadQuery.data?.emails;
    if (!currentEmails || currentEmails.length === 0) return;

    const newest = currentEmails[currentEmails.length - 1];

    if (initializedThreadIdRef.current !== threadId) {
      const initial = new Set<string>();
      for (const email of currentEmails) {
        if (email.id === newest?.id || !email.keywords.$seen) initial.add(email.id);
      }
      setExpandedIds(initial);
      knownEmailIdsRef.current = new Set(currentEmails.map((email) => email.id));
      initializedThreadIdRef.current = threadId;
      return;
    }

    // Same thread, later refetch: admit only ids not seen before for this
    // thread — the newest and any unread arrival stay expanded, mirroring
    // the initial-seed rule above. Every already-known id's expand state
    // (including whatever the user has since done to it) is left untouched.
    const newlyArrived = currentEmails.filter((email) => !knownEmailIdsRef.current.has(email.id));
    if (newlyArrived.length > 0) {
      setExpandedIds((previous) => {
        const next = new Set(previous);
        for (const email of newlyArrived) {
          if (email.id === newest?.id || !email.keywords.$seen) next.add(email.id);
        }
        return next;
      });
      knownEmailIdsRef.current = new Set(currentEmails.map((email) => email.id));
    }
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
      {/* GH #214: the bar used to be overflow-x-hidden while its buttons are
          all shrink-0 whitespace-nowrap — anything past the viewport's width
          was simply clipped away with no way to reach it. In Archive, in
          Spanish, the row wants ~450px inside the ~331px a 375px phone leaves,
          which put Delete and Labels permanently out of reach. `auto` keeps
          the same single-row layout (wrapping would push the bar past its
          fixed 52px) and makes the overflow scrollable instead of lost.
          The label popover is unaffected: it renders into a document.body
          portal (see the labelMenuRef comment above), so it never depended on
          this axis being hidden in the first place. */}
      <div
        data-testid="thread-actions-bar"
        className="flex h-[52px] shrink-0 items-center gap-[6px] overflow-x-auto border-b border-line px-[22px]"
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
            //
            // GH #134: a cid: reference is only hidden when it will actually
            // resolve to a rendered image (isSafeInlineImage — the same
            // allowlist EmailBody itself uses to decide what to fetch/inline).
            // A cid: pointing at any other type (e.g. a PDF invoice
            // referenced via cid:) never renders inline no matter what, so
            // excluding it here too would make the file completely
            // unreachable — neither shown inline (broken image icon) nor
            // downloadable. It must still surface as a regular attachment.
            //
            // GH #275: an inline cid image whose blob fetch failed (reported
            // up via onInlineImageError below) never actually rendered inline,
            // so hiding its chip too would make it unreachable — it's kept
            // visible as a downloadable chip in that case.
            const referencedCids = extractReferencedCids(email.bodyHtml);
            const failedCids = failedInlineCids[email.id] ?? [];
            const visibleAttachments = email.attachments.filter((attachment) => {
              const rendersInline =
                Boolean(attachment.cid) &&
                referencedCids.has(attachment.cid as string) &&
                isSafeInlineImage(attachment.type);
              if (!rendersInline) return true;
              return attachment.cid != null && failedCids.includes(attachment.cid);
            });

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
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[14.5px] font-semibold">{addressLabel(sender)}</span>
                    {/* GH #136: renders purely from the server-derived
                        verdict — never from `sender`/addressLabel above, so a
                        sender cannot forge this mark via their display name. */}
                    <SenderAuthBadge verdict={email.senderAuth} />
                  </span>
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
                  <EmailBody
                    bodyHtml={email.bodyHtml}
                    bodyText={email.bodyText}
                    attachments={email.attachments}
                    bodyTruncated={email.bodyTruncated}
                    onInlineImageError={(cids) => reportFailedInlineCids(email.id, cids)}
                  />
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
                      {/* GH #42: the design's brand footer puts a second,
                          muted 12.5px line under the sender's name — a job
                          title ("Ingeniería de plataforma") in the prototype,
                          which is mock data: no such field exists on a JMAP
                          Email, in the contacts schema, or anywhere else the
                          server can supply. The address is the only real
                          identity fact available, so it takes that slot.
                          Skipped when the name line already IS the address —
                          addressLabel falls back to `email` for senders with
                          no display name, and printing it twice reads as a
                          rendering bug rather than as design parity. */}
                      {sender?.name && (
                        <p
                          data-testid="thread-footer-sender-address"
                          className="mt-0.5 text-[12.5px] text-muted"
                        >
                          {sender.email}
                        </p>
                      )}
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
                    {/* GH #249: Responder / Responder a todos / Reenviar want
                        ~400px, and a 375px phone leaves ~335px for the reader
                        column — so without flex-wrap the row overflowed and
                        Reenviar was pushed off screen. #214 gave the reader's
                        top action bar and the dialog rows this same treatment
                        and left this one behind. shrink-0 on each button so the
                        row wraps between buttons rather than crushing their
                        labels. */}
                    <div
                      data-testid="thread-footer-actions"
                      className="mt-[26px] flex flex-wrap gap-2.5"
                    >
                      <button
                        type="button"
                        onClick={() => openCompose(`reply:${lastEmail.id}`)}
                        className="flex h-[38px] shrink-0 items-center gap-2 rounded-[10px] border border-line bg-panel px-[18px] text-[13.5px] font-semibold text-ink transition hover:bg-hover"
                      >
                        <ReplyIcon size={14} />
                        {t("composer.reply")}
                      </button>
                      {showReplyAll && (
                        <button
                          type="button"
                          onClick={() => openCompose(`reply-all:${lastEmail.id}`)}
                          className="flex h-[38px] shrink-0 items-center gap-2 rounded-[10px] border border-line bg-panel px-[18px] text-[13.5px] font-semibold text-ink transition hover:bg-hover"
                        >
                          {t("composer.replyAll")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openCompose(`forward:${lastEmail.id}`)}
                        className="flex h-[38px] shrink-0 items-center gap-2 rounded-[10px] border border-line bg-panel px-[18px] text-[13.5px] font-semibold text-ink transition hover:bg-hover"
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
