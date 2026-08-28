import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchMailboxes } from "./api";
import { PERSONAL_MAILBOXES_QUERY_KEY } from "./newMailNotice";
import { mailRetry } from "./queryErrors";
import { applyFaviconBadge } from "../../app/ui/faviconBadge";

// GH #338: the foreground half of "there is new mail".
//
// A hidden tab gets a Notification (see newMailNotice); a VISIBLE one used to
// get nothing at all — the title was permanently "Céfiro" and the icon never
// changed, so the only hint was the list refetching under the user. The count
// now goes where a tab is looked at even when its content is not.
//
// Mounting this also keeps the personal mailboxes query ACTIVE for as long as
// the mail screen is open, which is what lets an invalidation actually refetch
// it — and therefore what lets the arrival notice compare a before and an after
// even while a shared mailbox is the one on screen.

export const UNREAD_TITLE_BASE = "Céfiro";

export function useUnreadBadge(): void {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: PERSONAL_MAILBOXES_QUERY_KEY,
    queryFn: () => fetchMailboxes(),
    retry: mailRetry,
  });

  const unread = data?.find((mailbox) => mailbox.role === "inbox")?.unreadEmails ?? 0;

  useEffect(() => {
    document.title = unread > 0 ? t("mail.unreadTitle", { count: unread }) : UNREAD_TITLE_BASE;
    applyFaviconBadge(unread);
    // Leaving the mail screen must leave the tab as it was found: a stale "(5)"
    // on the settings screen would be a count of nothing.
    return () => {
      document.title = UNREAD_TITLE_BASE;
      applyFaviconBadge(0);
    };
  }, [unread, t]);
}
