import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import type { EmailAddress, EmailDetail } from "@webmail/shared";
import { fetchThread, updateMessage } from "../mailbox/api";
import { mailErrorKey, mailRetry } from "../mailbox/queryErrors";
import { Avatar } from "../../app/ui/Avatar";
import { ArchiveIcon, ArrowLeftIcon, StarFilledIcon, StarIcon } from "../../app/ui/icons";
import { isPlainShortcut } from "../../app/ui/shortcuts";
import { useToast } from "../../app/ui/toast";
import { EmailBody } from "./EmailBody";

interface ThreadViewProps {
  threadId: string;
  archiveMailboxId: string | null;
}

function addressLabel(address: EmailAddress | undefined) {
  if (!address) return "";
  return address.name || address.email;
}

function formatDate(receivedAt: string) {
  const date = new Date(receivedAt);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function formatSizeKb(size: number) {
  return `${(size / 1024).toFixed(1)} KB`;
}

// Mirrors the server's SAFE_INLINE_CONTENT_TYPES allowlist (apps/server/src/modules/mail/router.ts):
// only these types are ever served inline (without dl=1), so only these get a "view" link.
const PREVIEWABLE_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function isPreviewable(type: string): boolean {
  return PREVIEWABLE_CONTENT_TYPES.has(type.split(";")[0]?.trim().toLowerCase() ?? "");
}

function blobUrl(blobId: string, name: string, type: string, download: boolean): string {
  const query = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  return `/api/mail/blobs/${encodeURIComponent(blobId)}?${query}${download ? "&dl=1" : ""}`;
}

export function ThreadView({ threadId, archiveMailboxId }: ThreadViewProps) {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const threadQuery = useQuery({
    queryKey: ["mail", "thread", threadId],
    queryFn: () => fetchThread(threadId),
    retry: mailRetry,
  });

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

  const starMutation = useMutation({
    mutationFn: ({ email, starred }: { email: EmailDetail; starred: boolean }) =>
      updateMessage(email.id, { keywords: { $flagged: starred } }),
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
  const starred = Boolean(lastEmail.keywords.$flagged);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-2 overflow-x-hidden border-b border-line px-4">
        <button
          type="button"
          onClick={backToList}
          aria-label={t("mail.backToList")}
          className="flex h-8 items-center rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-ink lg:hidden"
        >
          <ArrowLeftIcon />
        </button>
        {showArchive && (
          <button
            type="button"
            onClick={() => archiveMutation.mutate(lastEmail)}
            className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-ink"
          >
            <ArchiveIcon size={16} />
            {t("mail.archive")}
          </button>
        )}
        <button
          type="button"
          aria-label={t(starred ? "mail.unstar" : "mail.star")}
          onClick={() => starMutation.mutate({ email: lastEmail, starred: !starred })}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-ink"
        >
          {starred ? <StarFilledIcon size={16} /> : <StarIcon size={16} />}
          {t(starred ? "mail.unstar" : "mail.star")}
        </button>
        <button
          type="button"
          onClick={() => openCompose(`reply:${lastEmail.id}`)}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-ink"
        >
          {t("composer.reply")}
        </button>
        <button
          type="button"
          onClick={() => openCompose(`reply-all:${lastEmail.id}`)}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-ink"
        >
          {t("composer.replyAll")}
        </button>
        <button
          type="button"
          onClick={() => openCompose(`forward:${lastEmail.id}`)}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-ink"
        >
          {t("composer.forward")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[780px] px-5 pb-16 pt-8 md:px-10" style={{ animation: "fadeUp 0.25s ease-out" }}>
          <h2 className="text-[26px] font-semibold leading-[1.25] tracking-[-0.01em]">
            {lastEmail.subject || t("mail.noSubject")}
          </h2>
          {emails.map((email) => {
            const toCcLabel = [...email.to, ...email.cc].map(addressLabel).filter(Boolean).join(", ");
            const sender = email.from[0];

            return (
              <article key={email.id} className="mt-6 border-b border-line pb-6 last:border-b-0">
                <div className="flex items-center gap-3">
                  <Avatar name={sender?.name ?? null} email={sender?.email ?? "?"} size={42} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-semibold">{addressLabel(sender)}</span>
                      <span className="text-xs text-muted">{formatDate(email.receivedAt)}</span>
                    </div>
                    {toCcLabel && <div className="truncate text-xs text-muted">{toCcLabel}</div>}
                  </div>
                </div>
                {email.attachments.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {email.attachments.map((attachment) => {
                      const attachmentName = attachment.name ?? "attachment";
                      return (
                        <span
                          key={attachment.blobId}
                          className="flex items-center gap-1 rounded-full bg-soft px-2 py-1 text-xs"
                        >
                          <span>
                            {attachmentName} ({formatSizeKb(attachment.size)})
                          </span>
                          <a
                            href={blobUrl(attachment.blobId, attachmentName, attachment.type, true)}
                            className="text-accent underline"
                          >
                            {t("attachments.download")}
                          </a>
                          {isPreviewable(attachment.type) && (
                            <a
                              href={blobUrl(attachment.blobId, attachmentName, attachment.type, false)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-accent underline"
                            >
                              {t("attachments.view")}
                            </a>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="mt-3 text-[15px] leading-[1.65]">
                  <EmailBody bodyHtml={email.bodyHtml} bodyText={email.bodyText} />
                </div>
                {email.id === lastEmail.id && (
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
                        <span className="font-bold tracking-[0.14em] text-accent">CÉFIRO</span> ·{" "}
                        {t("app.sealMotto")}
                      </span>
                    </p>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
