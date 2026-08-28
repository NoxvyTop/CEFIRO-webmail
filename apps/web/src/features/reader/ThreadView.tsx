import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import type { EmailAddress, EmailDetail, Identity } from "@webmail/shared";
import { MailApiError, copyMessageToInbox, destroyMessages, fetchInstanceSettings, fetchThread, updateMessage, updateMessages } from "../mailbox/api";
import { fetchPreferences } from "../mailbox/groups";
import { mailErrorKey, mailRetry, mailRetryDelay } from "../mailbox/queryErrors";
import { EMAIL_QUERY_KEYS, MAILBOX_QUERY_KEYS } from "../mailbox/useMailEvents";
import { AUTH_QUERY_KEY } from "../auth/useAuth";
import { useAuth } from "../auth/useAuth";
import { fetchIdentities } from "../composer/api";
import { fetchAiStatus } from "../composer/aiApi";
import { replyRecipients } from "../composer/reply";
import { errorMessageKey } from "../../app/errorMessages";
import { Avatar } from "../../app/ui/Avatar";
import { Button } from "../../app/ui/Button";
import { CefiroLoader } from "../../app/ui/CefiroLoader";
import { ArchiveIcon, ArrowLeftIcon, InboxIcon, ReplyIcon, StarFilledIcon, StarIcon, TagIcon, TrashIcon } from "../../app/ui/icons";
import { labelBackground, labelColor, labelDisplayName, userLabels } from "../../app/ui/labels";
import { PanelError } from "../../app/ui/PanelError";
import { formatRelativeTime } from "../../app/ui/relative-time";
import { isPlainShortcut } from "../../app/ui/shortcuts";
import { useToast } from "../../app/ui/toast";
import { useFocusTrap } from "../../app/ui/useFocusTrap";
import { useMenuKeyboardNav } from "../../app/ui/useMenuKeyboardNav";
import { AiSummaryCard } from "./AiSummaryCard";
import { describeAudience } from "./audience";
import { AttachmentCard } from "./AttachmentCard";
import { EmailBody, isSafeInlineImage } from "./EmailBody";
import { extractReferencedCids } from "./sanitize";
import { SenderAuthBadge } from "./SenderAuthBadge";
import { SenderTrustBadge } from "./SenderTrustBadge";
import { fetchTrustedServices, trustService, untrustService } from "./trustApi";

// GH #314: the domain part of a From address, for the trust-this-service
// affordance. Same rule as the server's domainOf (last "@", lowercased) so the
// domain the button offers is the one the server will match against.
function senderDomain(address: string | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1).toLowerCase();
  return domain === "" ? null : domain;
}

// GH #314: the trusted-services list is only needed to decide whether a
// "trusted-service" sender can be UN-trusted (user list) or not (seed), so it
// is fetched only when a message in the thread actually carries that tier.
const TRUSTED_SERVICES_QUERY_KEY = ["mail", "trusted-services"] as const;

interface ThreadViewProps {
  threadId: string;
  archiveMailboxId: string | null;
  inboxMailboxId: string | null;
  // GH #133: optional (defaults to null) so existing callers/tests that don't
  // care about Trash keep compiling unchanged — mirrors archiveMailboxId's
  // role, just for the trash-role mailbox instead.
  trashMailboxId?: string | null;
  // GH #13/#50: the active shared mailbox this thread is being read from —
  // threaded into the thread query key and every read/mutation so the whole
  // reader operates on that account. Absent = personal mailbox (unchanged).
  accountId?: string;
  // #343: the mailbox the list this reader was opened from is scoped to, so
  // archive/unarchive/delete/destroy act on every message of the CONVERSATION
  // sitting in it rather than on the newest one alone. Null/absent = a view
  // that spans folders (starred, a label), where there is no current mailbox
  // to scope by and the actions keep their single-message meaning.
  currentMailboxId?: string | null;
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

// GH #345: hoisted to module scope (out of the component body) so the error
// branch below — rendered before `lastEmail` and the rest of the action-bar
// state exist — can share the exact same button styling as the real bar,
// instead of the error state's back button looking like a different control.
const ACTION_BUTTON_BASE_CLASS =
  "flex h-8 shrink-0 items-center gap-[7px] whitespace-nowrap rounded-lg px-3 text-[13px] transition hover:bg-hover";
const ACTION_BUTTON_CLASS = `${ACTION_BUTTON_BASE_CLASS} text-ink`;

export function ThreadView({
  threadId, archiveMailboxId, inboxMailboxId, trashMailboxId = null, accountId,
  currentMailboxId = null,
}: ThreadViewProps) {
  const { t, i18n } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { user } = useAuth();

  const threadQuery = useQuery({
    queryKey: ["mail", "thread", threadId, accountId ?? null],
    queryFn: () => fetchThread(threadId, accountId),
    retry: mailRetry,
    retryDelay: mailRetryDelay,
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
  const identityEmails = identities.map((identity) => identity.email);
  // #340: the addresses that count as "me" when working out who a received
  // message was addressed to (see describeAudience below). Every non-primary
  // identity is a GROUP address (deriveGroupAddresses, ./mailbox/groups.ts), so
  // handing the whole identity list over made a message delivered to the group's
  // mailbox read "para mí" — the user's own address was nowhere on it. Only the
  // signed-in user's own address is "me"; the group gets named. Falls back to
  // the identity list while the session query is still resolving, which is the
  // pre-#340 behaviour and never worse than it.
  const selfEmails = user ? [user.email] : identityEmails;

  // GH #339: whether this instance has an AI provider configured at all. The
  // summary card used to render unconditionally, so on an instance with AI off
  // the reader offered "Resumir con IA" / "Resumir conversación" whose only
  // possible outcome was the `ai_disabled` error that hides the card — an
  // action painted purely to fail. Same `["ai","status"]` key the composer
  // reads, so both surfaces share one answer per session, and `false` while it
  // loads (or when the probe itself fails) keeps AI-off the safe default.
  const { data: aiEnabled = false } = useQuery({ queryKey: ["ai", "status"], queryFn: fetchAiStatus });

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
  // #348: WAI-ARIA menu keyboard behavior — focus the first label on open,
  // ArrowUp/ArrowDown/Home/End move between labels. Shares labelMenuRef
  // (rather than creating its own ref) since the click-outside handler below
  // already needs a ref to this same portaled element.
  useMenuKeyboardNav(labelMenuOpen, labelMenuRef);

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

  // #343: archive/unarchive/delete/star/keyword had no onError at all, so a
  // 5xx left the reader exactly as it was with nothing said, and a 401 left the
  // user in front of a thread that silently refused every write until
  // ["auth","me"] happened to refetch on window focus. Revalidating the session
  // is what hands them to the login screen (RequireAuth reads that same key).
  function reportMutationError(error: unknown) {
    if (error instanceof MailApiError && error.status === 401) {
      queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    }
    showToast(t(mailErrorKey(error)));
  }

  // #343: the list row this reader was opened from is a CONVERSATION, so a move
  // has to take every message of the thread that sits in the mailbox being
  // viewed — moving `lastEmail` alone left the row in Recibidos, now showing the
  // previous message of the same conversation. Messages of the thread that live
  // elsewhere (the copy in Enviados, say) stay where they are.
  //
  // Without a current mailbox the view spans folders (starred, a label): there
  // is nothing to scope by, so the action keeps its single-message meaning
  // rather than sweeping the thread out of every folder at once.
  function threadMessagesInCurrentMailbox(): EmailDetail[] {
    const newest = emails[emails.length - 1];
    if (!newest) return [];
    if (!currentMailboxId) return [newest];
    const inMailbox = emails.filter((email) => email.mailboxIds.includes(currentMailboxId));
    return inMailbox.length > 0 ? inMailbox : [newest];
  }

  const archiveMutation = useMutation({
    mutationFn: (targets: EmailDetail[]) => {
      if (!archiveMailboxId) throw new Error("no archive mailbox");
      return updateMessages(
        targets.map((target) => target.id),
        { mailboxIds: { [archiveMailboxId]: true } },
        accountId,
      );
    },
    onSuccess: () => {
      showToast(`${t("mail.archived")} · ${t("mail.archivedHint")}`);
      backToList();
    },
    onError: reportMutationError,
    // #343: a partial move still changed the server, so the listings and the
    // mailbox counters must be re-read whether or not every PATCH succeeded.
    onSettled: invalidateAfterMailboxMove,
  });

  // Inverse of archiveMutation: moves the conversation back into Recibidos.
  // Same single-mailbox move (JMAP mailboxIds is a full set, so this drops the
  // archive membership and adds the inbox), same post-success flow.
  const unarchiveMutation = useMutation({
    mutationFn: (targets: EmailDetail[]) => {
      if (!inboxMailboxId) throw new Error("no inbox mailbox");
      return updateMessages(
        targets.map((target) => target.id),
        { mailboxIds: { [inboxMailboxId]: true } },
        accountId,
      );
    },
    onSuccess: () => {
      showToast(t("mail.unarchived"));
      backToList();
    },
    onError: reportMutationError,
    onSettled: invalidateAfterMailboxMove,
  });

  // GH #133: Delete moves the conversation to Trash — the same single-mailbox
  // move archiveMutation/unarchiveMutation above already use (JMAP
  // mailboxIds is a full-set replace). Recoverable, so it needs no
  // confirmation — just feedback, mirroring archiveMutation's toast.
  const deleteMutation = useMutation({
    mutationFn: (targets: EmailDetail[]) => {
      if (!trashMailboxId) throw new Error("no trash mailbox");
      return updateMessages(
        targets.map((target) => target.id),
        { mailboxIds: { [trashMailboxId]: true } },
        accountId,
      );
    },
    onSuccess: () => {
      showToast(t("mail.deleted"));
      backToList();
    },
    onError: reportMutationError,
    onSettled: invalidateAfterMailboxMove,
  });

  const [deletePermanentlyConfirmOpen, setDeletePermanentlyConfirmOpen] = useState(false);
  const [destroyError, setDestroyError] = useState<string | null>(null);

  // GH #133: permanently destroys the last email. Irreversible, so this is
  // only ever invoked from the explicit confirm button inside
  // DeletePermanentlyConfirmDialog below — never directly from the action
  // bar click.
  const destroyMutation = useMutation({
    mutationFn: (targets: EmailDetail[]) =>
      destroyMessages(targets.map((target) => target.id), accountId),
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

  // GH #13/#50 (G-2): copies the last email of a SHARED mailbox into the
  // member's own personal inbox. Only ever reachable when `accountId` is set —
  // i.e. a shared mailbox is active (the button below is hidden otherwise), so
  // the guard is defense-in-depth, mirroring archive/unarchive's own guards.
  // The copy lands in a different account (personal), so nothing in the
  // currently-viewed shared account changes — success is just a toast.
  const copyToInboxMutation = useMutation({
    mutationFn: (email: EmailDetail) => {
      if (!accountId) throw new Error("no shared account");
      return copyMessageToInbox(email.id, accountId);
    },
    onSuccess: () => {
      showToast(t("mail.copiedToInbox"));
    },
    onError: (err) => {
      // Same mapped-key treatment the destroy path uses (GH #215): an unmapped
      // server code resolves to the namespace's generic message rather than
      // being shown to the user as a literal i18n key.
      showToast(t(errorMessageKey("mail", err instanceof MailApiError ? err.code : null)), {
        variant: "error",
      });
    },
  });

  const starMutation = useMutation({
    mutationFn: ({ email, starred }: { email: EmailDetail; starred: boolean }) =>
      updateMessage(email.id, { keywords: { $flagged: starred } }, accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail", "thread", threadId] });
      queryClient.invalidateQueries({ queryKey: ["mail", "messages"] });
    },
    onError: reportMutationError,
  });

  // GH #314: "Trust <domain>" / "Stop trusting <domain>". Both invalidate the
  // thread query so the badge flips from the server's own re-resolution
  // rather than from an optimistic guess — the server is the only party that
  // knows whether DMARC passed for that message, and the badge must never
  // appear on a message it would not vouch for. The trusted-services list is
  // invalidated too so the untrust affordance follows the user list.
  const trustedServicesQuery = useQuery({
    queryKey: TRUSTED_SERVICES_QUERY_KEY,
    queryFn: fetchTrustedServices,
    enabled: (threadQuery.data?.emails ?? []).some((email) => email.senderTrust === "trusted-service"),
  });
  const userTrustedDomains = trustedServicesQuery.data?.user ?? [];

  function invalidateAfterTrustChange() {
    queryClient.invalidateQueries({ queryKey: ["mail", "thread", threadId] });
    queryClient.invalidateQueries({ queryKey: TRUSTED_SERVICES_QUERY_KEY });
  }

  const trustMutation = useMutation({
    mutationFn: (domain: string) => trustService(domain),
    onSuccess: (_result, domain) => {
      invalidateAfterTrustChange();
      showToast(t("mail.senderTrust.trusted", { domain }));
    },
    onError: (err) => {
      // Mapped-key treatment (GH #215): an unmapped server code resolves to
      // the namespace's generic message, never to a literal i18n key.
      showToast(t(errorMessageKey("mail", err instanceof MailApiError ? err.code : null)), {
        variant: "error",
      });
    },
  });

  const untrustMutation = useMutation({
    mutationFn: (domain: string) => untrustService(domain),
    onSuccess: (_result, domain) => {
      invalidateAfterTrustChange();
      showToast(t("mail.senderTrust.untrusted", { domain }));
    },
    onError: (err) => {
      showToast(t(errorMessageKey("mail", err instanceof MailApiError ? err.code : null)), {
        variant: "error",
      });
    },
  });

  // Mirrors starMutation's shape: toggles a single JMAP keyword on the last
  // email, the same pattern the star affordance already uses.
  const keywordMutation = useMutation({
    mutationFn: ({ email, label, checked }: { email: EmailDetail; label: string; checked: boolean }) =>
      updateMessage(email.id, { keywords: { [label]: checked } }, accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail", "thread", threadId] });
      queryClient.invalidateQueries({ queryKey: ["mail", "messages"] });
    },
    onError: reportMutationError,
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
    // GH #345: this used to be a bare `<p role="alert">` rendered BEFORE the
    // action bar that holds the `lg:hidden` back button (below `lg`,
    // MailPage hides the message list while `?thread=` is set) — a failed
    // thread load left a mobile reader with no way back and no way to retry.
    return (
      <div className="flex h-full flex-col">
        <div
          data-testid="thread-actions-bar"
          className="flex h-[52px] shrink-0 items-center gap-[6px] border-b border-line px-[22px]"
        >
          <button
            type="button"
            onClick={backToList}
            aria-label={t("mail.backToList")}
            className={`${ACTION_BUTTON_CLASS} px-2 lg:hidden`}
          >
            <ArrowLeftIcon />
          </button>
        </div>
        <PanelError
          message={t(mailErrorKey(threadQuery.error))}
          onRetry={() => void threadQuery.refetch()}
        />
      </div>
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
          className={`${ACTION_BUTTON_CLASS} px-2 lg:hidden`}
        >
          <ArrowLeftIcon />
        </button>
        {showArchive && (
          <button
            type="button"
            onClick={() => archiveMutation.mutate(threadMessagesInCurrentMailbox())}
            className={ACTION_BUTTON_CLASS}
          >
            <ArchiveIcon size={15} />
            {t("mail.archive")}
          </button>
        )}
        {showUnarchive && (
          <button
            type="button"
            onClick={() => unarchiveMutation.mutate(threadMessagesInCurrentMailbox())}
            className={ACTION_BUTTON_CLASS}
          >
            <InboxIcon size={15} />
            {t("mail.unarchive")}
          </button>
        )}
        {showDelete && (
          <button
            type="button"
            onClick={() => deleteMutation.mutate(threadMessagesInCurrentMailbox())}
            className={ACTION_BUTTON_CLASS}
          >
            <TrashIcon size={15} />
            {t("mail.delete")}
          </button>
        )}
        {showDeletePermanently && (
          <button
            type="button"
            onClick={() => setDeletePermanentlyConfirmOpen(true)}
            className={ACTION_BUTTON_CLASS}
          >
            <TrashIcon size={15} />
            {t("mail.deletePermanently")}
          </button>
        )}
        {/* GH #13/#50 (G-2): copy-to-my-inbox is offered ONLY while a shared
            mailbox is active (accountId set). On the personal mailbox it is
            hidden — copying a message to the same inbox it already lives in is
            meaningless, and the server refuses it anyway. */}
        {accountId && (
          <button
            type="button"
            onClick={() => copyToInboxMutation.mutate(lastEmail)}
            disabled={copyToInboxMutation.isPending}
            className={ACTION_BUTTON_CLASS}
          >
            <InboxIcon size={15} />
            {t("mail.copyToInbox")}
          </button>
        )}
        <button
          type="button"
          aria-label={t(starred ? "mail.unstar" : "mail.star")}
          onClick={() => starMutation.mutate({ email: lastEmail, starred: !starred })}
          className={`${ACTION_BUTTON_BASE_CLASS} ${starred ? "text-star" : "text-ink"}`}
        >
          {starred ? <StarFilledIcon size={15} /> : <StarIcon size={15} />}
          {t(starred ? "mail.unstar" : "mail.star")}
        </button>
        <button
          type="button"
          onClick={() => openCompose(`reply:${lastEmail.id}`)}
          className={ACTION_BUTTON_CLASS}
        >
          <ReplyIcon size={15} />
          {t("composer.reply")}
        </button>
        {showReplyAll && (
          <button
            type="button"
            onClick={() => openCompose(`reply-all:${lastEmail.id}`)}
            className={ACTION_BUTTON_CLASS}
          >
            {t("composer.replyAll")}
          </button>
        )}
        <button
          type="button"
          onClick={() => openCompose(`forward:${lastEmail.id}`)}
          className={ACTION_BUTTON_CLASS}
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
          className={ACTION_BUTTON_CLASS}
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
            // GH #314: the trust-this-service affordance. Offered ONLY when
            // the server already vouches for the message's authenticity
            // (senderAuth "pass") and asserts no tier yet — never on a DMARC
            // fail or unknown, where trusting the domain would not change the
            // badge and would only teach the reader to click through a
            // warning. Not offered for a "known" sender either: Tier A is a
            // fact about correspondence, not a preference to set. The reverse
            // affordance appears only when the domain is on the USER list —
            // a seed entry cannot be removed per user (the server answers
            // 409), so offering it would be a button that always fails.
            // Rendered outside senderHeaderContent because that content is
            // the header <button> when the message is collapsible, and a
            // button inside a button is invalid HTML.
            const domain = senderDomain(sender?.email);
            const offerTrust = domain !== null && email.senderAuth === "pass" && email.senderTrust === "none";
            const offerUntrust =
              domain !== null && email.senderTrust === "trusted-service" && userTrustedDomains.includes(domain);
            const trustAction =
              domain !== null && (offerTrust || offerUntrust) ? (
                <div className="mb-[18px] -mt-2">
                  <Button
                    variant="secondary"
                    className="rounded-full px-3 py-1 text-[12.5px] font-semibold"
                    disabled={trustMutation.isPending || untrustMutation.isPending}
                    onClick={() => (offerTrust ? trustMutation.mutate(domain) : untrustMutation.mutate(domain))}
                  >
                    {offerTrust
                      ? t("mail.senderTrust.trustAction", { domain })
                      : t("mail.senderTrust.untrustAction", { domain })}
                  </Button>
                </div>
              ) : null;

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
                    {/* GH #314: the positive-only tier above it, tied to the
                        same `from[0]` address printed just below — so the
                        reader can check exactly who is being vouched for. */}
                    {sender && <SenderTrustBadge trust={email.senderTrust} address={sender.email} />}
                  </span>
                  {/* Sent messages show "Para: <recipients>" and so only
                      render when there are recipients; received messages always
                      show the sender + a computed audience ("para mí", "para mí
                      y N más", …) derived from the real to/cc — never a fixed
                      string — so the gate differs by branch. */}
                  {(isSentByMe ? toCcLabel : sender) && (
                    <span className="block truncate text-[12.5px] text-muted">
                      {isSentByMe
                        ? `${t("mail.sentTo")} ${toCcLabel}`
                        : `${sender?.email} · ${describeAudience(email.to, email.cc, selfEmails, t)}`}
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
                {trustAction}
                {isNewest && aiEnabled && (
                  // #308: `emails` is chronological (oldest→newest, the same
                  // order the server hashes) so its ids key the persistent
                  // summary cache — a new reply changes the set and misses.
                  <AiSummaryCard
                    messageId={email.id}
                    threadId={threadId}
                    messageCount={emails.length}
                    emailIds={emails.map((threadEmail) => threadEmail.id)}
                  />
                )}
                <div className="mt-3 text-[15px] leading-[1.65]">
                  <EmailBody
                    bodyHtml={email.bodyHtml}
                    bodyText={email.bodyText}
                    attachments={email.attachments}
                    bodyTruncated={email.bodyTruncated}
                    accountId={accountId}
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
                        <AttachmentCard key={attachment.blobId} attachment={attachment} accountId={accountId} />
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
          onConfirm={() => destroyMutation.mutate(threadMessagesInCurrentMailbox())}
          onCancel={handleCancelDeletePermanently}
        />
      )}
    </div>
  );
}
