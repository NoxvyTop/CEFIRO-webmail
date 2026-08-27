import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { ACTIVE_ACCOUNT_PARAM, fetchSharedAccounts } from "./api";

/**
 * GH #13/#50 (G-4) — the read-only indicator shown inside the mail view when a
 * shared mailbox is active (`?account=<id>`). The account selector that used to
 * name the active mailbox in the top bar is gone, so this restores that
 * orientation without it: it names the active shared mailbox and offers a way
 * back to the personal inbox ("Volver a mi buzón" → `/`, dropping the param).
 *
 * Renders nothing on the personal mailbox (no `account` param) and nothing
 * until the account is resolvable in the shared-accounts list — so the personal
 * experience is byte-identical for everyone else.
 */
export function SharedMailboxBanner() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const activeAccountId = searchParams.get(ACTIVE_ACCOUNT_PARAM);

  const sharedAccountsQuery = useQuery({
    queryKey: ["mail", "shared-accounts"],
    queryFn: fetchSharedAccounts,
    // Only the personal view is the default: don't reach for the list at all
    // unless a shared mailbox is actually active.
    enabled: Boolean(activeAccountId),
  });

  if (!activeAccountId) return null;

  const account = (sharedAccountsQuery.data ?? []).find((candidate) => candidate.id === activeAccountId);
  // The account param is set but not (yet) resolvable — while the list loads, or
  // if it names a mailbox the member can no longer reach. Nothing to orient by,
  // so show nothing rather than a half-formed banner.
  if (!account) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-soft px-4 py-2 text-xs text-muted">
      <span className="font-medium text-ink">
        {t("sharedMailboxes.activeIndicator", { name: account.name })}
      </span>
      <span aria-hidden="true">·</span>
      <Link to="/" className="text-accent-text underline">
        {t("sharedMailboxes.backToPersonal")}
      </Link>
    </div>
  );
}
