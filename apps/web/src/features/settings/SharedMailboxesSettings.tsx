import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { SharedAccount } from "@webmail/shared";
import { ACTIVE_ACCOUNT_PARAM, fetchSharedAccounts, setSharedAccountCopyPreference } from "../mailbox/api";
import { useToast } from "../../app/ui/toast";
import { SettingsLoadError, SettingsLoading } from "./PanelStates";

// The same key the header AccountSelector reads (GH #13/#50), so toggling an
// opt-in here and switching accounts there stay in step off one cache entry.
const SHARED_ACCOUNTS_QUERY_KEY = ["mail", "shared-accounts"] as const;

/**
 * GH #13/#50 — the "Buzones compartidos" settings panel. Lists the shared
 * mailboxes the member can reach and, per mailbox, lets them:
 *
 *  - "Entrar": switch the whole mail view to that shared account, the exact
 *    same mechanism the header AccountSelector uses — set the `account` URL
 *    param and land on the mailbox at `/`.
 *  - toggle the copy opt-in (G-3): persist whether they want copies of new mail
 *    from that mailbox in their own inbox. HONEST COPY: the toggle only records
 *    intent; automatic delivery is deferred (see docs/design/shared-mailboxes.md),
 *    so the helper text says so and points at the manual copy that already works.
 */
export function SharedMailboxesSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const sharedAccountsQuery = useQuery({
    queryKey: SHARED_ACCOUNTS_QUERY_KEY,
    queryFn: fetchSharedAccounts,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, copyOptIn }: { id: string; copyOptIn: boolean }) =>
      setSharedAccountCopyPreference(id, copyOptIn),
    // Optimistic: flip the toggle in the cache at once so it feels instant, and
    // keep the pre-flip snapshot to restore if the request fails.
    onMutate: async ({ id, copyOptIn }) => {
      await queryClient.cancelQueries({ queryKey: SHARED_ACCOUNTS_QUERY_KEY });
      const previous = queryClient.getQueryData<SharedAccount[]>(SHARED_ACCOUNTS_QUERY_KEY);
      queryClient.setQueryData<SharedAccount[]>(SHARED_ACCOUNTS_QUERY_KEY, (old) =>
        (old ?? []).map((account) => (account.id === id ? { ...account, copyOptIn } : account)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(SHARED_ACCOUNTS_QUERY_KEY, context.previous);
      }
      showToast(t("sharedMailboxes.copyError"));
    },
    // Reconcile with the server either way — a success confirms the flip, a
    // failure has already been reverted above and this just re-reads the truth.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SHARED_ACCOUNTS_QUERY_KEY });
    },
  });

  if (sharedAccountsQuery.isError) {
    return (
      <SettingsLoadError
        error={sharedAccountsQuery.error}
        onRetry={() => void sharedAccountsQuery.refetch()}
      />
    );
  }

  if (sharedAccountsQuery.isLoading) {
    return <SettingsLoading />;
  }

  const accounts = sharedAccountsQuery.data ?? [];

  // The common case for most members: no shared mailboxes at all. Say so plainly
  // instead of rendering an empty list.
  if (accounts.length === 0) {
    return <p className="text-sm text-muted">{t("sharedMailboxes.empty")}</p>;
  }

  function enter(accountId: string) {
    navigate(`/?${ACTIVE_ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("sharedMailboxes.description")}</p>
      <ul className="flex flex-col gap-3">
        {accounts.map((account) => (
          <li key={account.id} className="flex flex-col gap-3 rounded-md border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">{account.name}</span>
              <button
                type="button"
                onClick={() => enter(account.id)}
                className="rounded-[9px] border border-line-strong px-3 py-1 text-sm transition hover:border-accent hover:bg-hover"
              >
                {t("sharedMailboxes.enter")}
              </button>
            </div>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={account.copyOptIn}
                onChange={() =>
                  toggleMutation.mutate({ id: account.id, copyOptIn: !account.copyOptIn })
                }
                aria-label={t("sharedMailboxes.copyToggle", { name: account.name })}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <div className="flex flex-col gap-1">
                <span className="text-sm text-ink">{t("sharedMailboxes.copyLabel")}</span>
                <span className="text-xs text-muted">{t("sharedMailboxes.copyHelp")}</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
