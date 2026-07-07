import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import type { EmailAddress } from "@webmail/shared";
import { fetchThread } from "../mailbox/api";
import { mailErrorKey, mailRetry } from "../mailbox/queryErrors";
import { EmailBody } from "./EmailBody";

interface ThreadViewProps {
  threadId: string;
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

export function ThreadView({ threadId }: ThreadViewProps) {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();

  const threadQuery = useQuery({
    queryKey: ["mail", "thread", threadId],
    queryFn: () => fetchThread(threadId),
    retry: mailRetry,
  });

  function openCompose(param: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("compose", param);
      return next;
    });
  }

  if (threadQuery.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-amber-700">
        {t(mailErrorKey(threadQuery.error))}
      </p>
    );
  }

  const emails = threadQuery.data?.emails ?? [];
  const lastEmail = emails[emails.length - 1];

  if (!lastEmail) return null;

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-lg font-semibold">{lastEmail.subject || t("mail.noSubject")}</h2>
      {emails.map((email) => {
        const toCcLabel = [...email.to, ...email.cc].map(addressLabel).filter(Boolean).join(", ");

        return (
          <article key={email.id} className="rounded-md border p-3">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{addressLabel(email.from[0])}</span>
              <span className="text-xs text-gray-500">{formatDate(email.receivedAt)}</span>
            </div>
            {toCcLabel && <div className="text-xs text-gray-500">{toCcLabel}</div>}
            {email.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {email.attachments.map((attachment) => {
                  const attachmentName = attachment.name ?? "attachment";
                  return (
                    <span
                      key={attachment.blobId}
                      className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs"
                    >
                      <span>
                        {attachmentName} ({formatSizeKb(attachment.size)})
                      </span>
                      <a
                        href={blobUrl(attachment.blobId, attachmentName, attachment.type, true)}
                        className="text-blue-700 underline"
                      >
                        {t("attachments.download")}
                      </a>
                      {isPreviewable(attachment.type) && (
                        <a
                          href={blobUrl(attachment.blobId, attachmentName, attachment.type, false)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-700 underline"
                        >
                          {t("attachments.view")}
                        </a>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
            <div className="mt-2">
              <EmailBody bodyHtml={email.bodyHtml} bodyText={email.bodyText} />
            </div>
            {email.id === lastEmail.id && (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => openCompose(`reply:${email.id}`)}
                  className="rounded-md border px-2 py-1 text-xs"
                >
                  {t("composer.reply")}
                </button>
                <button
                  type="button"
                  onClick={() => openCompose(`reply-all:${email.id}`)}
                  className="rounded-md border px-2 py-1 text-xs"
                >
                  {t("composer.replyAll")}
                </button>
                <button
                  type="button"
                  onClick={() => openCompose(`forward:${email.id}`)}
                  className="rounded-md border px-2 py-1 text-xs"
                >
                  {t("composer.forward")}
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
