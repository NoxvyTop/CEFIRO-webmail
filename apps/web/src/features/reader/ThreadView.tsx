import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import type { EmailAddress, EmailDetail, Identity } from "@webmail/shared";
import { fetchThread, updateMessage } from "../mailbox/api";
import { fetchPreferences } from "../mailbox/groups";
import { mailErrorKey, mailRetry } from "../mailbox/queryErrors";
import { fetchIdentities } from "../composer/api";
import { Avatar } from "../../app/ui/Avatar";
import { ArchiveIcon, ArrowLeftIcon, InboxIcon, ReplyIcon, StarFilledIcon, StarIcon, TagIcon } from "../../app/ui/icons";
import { CANONICAL_LABELS, labelBackground, labelColor, labelDisplayName, userLabels } from "../../app/ui/labels";
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
}

function addressLabel(address: EmailAddress | undefined) {
  if (!address) return "";
  return address.name || address.email;
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

export function ThreadView({ threadId, archiveMailboxId, inboxMailboxId }: ThreadViewProps) {
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
  const customLabels = preferencesQuery.data?.customLabels ?? [];
  // Only the registry of "known" labels (canonical + user-defined custom
  // ones) is toggleable from this menu, mirroring Gmail's "Label as" list —
  // an arbitrary keyword applied by some other client still shows read-only
  // as a subject-line chip, it just isn't offered as a checkbox here.
  const applyLabelSlugs = [...CANONICAL_LABELS, ...customLabels.map((custom) => custom.slug)];

  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const labelMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!labelMenuOpen) return;
    function handleMouseDown(event: MouseEvent) {
      if (labelMenuRef.current && !labelMenuRef.current.contains(event.target as Node)) {
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

  if (threadQuery.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-warn">
        {t(mailErrorKey(threadQuery.error))}
      </p>
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
  const starred = Boolean(lastEmail.keywords.$flagged);
  const showReplyAll = hasReplyAllRecipient(lastEmail, identities);

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
        <div ref={labelMenuRef} className="relative shrink-0">
          <button
            type="button"
            aria-label={t("mail.labels")}
            aria-haspopup="menu"
            aria-expanded={labelMenuOpen}
            onClick={() => setLabelMenuOpen((open) => !open)}
            className={actionButtonClass}
          >
            <TagIcon size={15} />
            {t("mail.labels")}
          </button>
          {labelMenuOpen && (
            <div
              role="menu"
              className="absolute left-0 top-[calc(100%+8px)] z-50 flex min-w-[190px] flex-col rounded-[12px] border border-line bg-panel py-1 shadow-pop"
            >
              {applyLabelSlugs.map((slug) => {
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
              })}
            </div>
          )}
        </div>
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
          {emails.map((email) => {
            const toCcLabel = [...email.to, ...email.cc].map(addressLabel).filter(Boolean).join(", ");
            const sender = email.from[0];
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

            return (
              <article key={email.id} className="mt-6 border-b border-line pb-6 last:border-b-0">
                <div className="flex items-center gap-3 border-b border-line pb-5 mb-[22px]">
                  <Avatar name={sender?.name ?? null} email={sender?.email ?? "?"} size={42} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14.5px] font-semibold">{addressLabel(sender)}</div>
                    {toCcLabel && (
                      <div className="truncate text-[12.5px] text-muted">
                        {isSentByMe ? `${t("mail.sentTo")} ${toCcLabel}` : `${sender?.email} · ${t("mail.toMeAndTeam")}`}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 text-[12.5px] text-muted">
                    {formatRelativeTime(email.receivedAt, { yesterdayLabel: t("mail.yesterday"), locale: i18n.language })}
                  </span>
                </div>
                {email.id === lastEmail.id && <AiSummaryCard messageId={email.id} />}
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
                {email.id === lastEmail.id && (
                  <>
                    <div className="mt-5 border-t border-line pt-4">
                      <p className="text-[13.5px] font-semibold">{addressLabel(sender)}</p>
                      <p className="mt-4 flex items-center gap-2 text-[11.5px] text-muted">
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
    </div>
  );
}
