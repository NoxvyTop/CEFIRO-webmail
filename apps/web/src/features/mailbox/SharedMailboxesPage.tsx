import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import type { SharedAccount } from "@webmail/shared";
import { ACTIVE_ACCOUNT_PARAM, fetchSharedAccounts, setSharedAccountCopyPreference } from "./api";
import { useToast } from "../../app/ui/toast";
// Reuses the settings panels' shared loading/failed primitives (GH #250) so the
// list keeps the exact non-content states it had as a settings panel (G-3).
import { SettingsLoadError, SettingsLoading } from "../settings/PanelStates";

// The same key the mail view banner reads (GH #13/#50), so toggling an opt-in
// here and switching accounts there stay in step off one cache entry.
const SHARED_ACCOUNTS_QUERY_KEY = ["mail", "shared-accounts"] as const;

/**
 * GH #13/#50 (G-4) — the "Buzones compartidos" page, reached from the left
 * sidebar. It replaces the former Settings panel (SharedMailboxesSettings) and
 * carries the exact same list logic:
 *
 *  - "Entrar": switch the whole mail view to that shared account — set the
 *    `account` URL param and land on the mailbox at `/`, the same mechanism the
 *    old header AccountSelector used.
 *  - toggle the copy opt-in (G-3): persist whether they want copies of new mail
 *    from that mailbox in their own inbox. Since GH #313 the server acts on it:
 *    a background worker copies each new message of the shared mailbox into the
 *    inbox of every member who opted in (see docs/design/shared-mailboxes.md),
 *    so the helper text describes exactly that. The manual "copy to my inbox"
 *    action on a message remains for mail that predates the opt-in.
 */
export function SharedMailboxesPage() {
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

  function enter(accountId: string) {
    navigate(`/?${ACTIVE_ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`);
  }

  const accounts = sharedAccountsQuery.data ?? [];

  let body: ReactNode;
  if (sharedAccountsQuery.isError) {
    body = (
      <SettingsLoadError
        error={sharedAccountsQuery.error}
        onRetry={() => void sharedAccountsQuery.refetch()}
      />
    );
  } else if (sharedAccountsQuery.isLoading) {
    body = <SettingsLoading />;
  } else if (accounts.length === 0) {
    // The common case for most members: no shared mailboxes at all. Say so plainly
    // instead of rendering an empty list.
    body = <p className="text-sm text-muted">{t("sharedMailboxes.empty")}</p>;
  } else {
    body = (
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

  return (
    // The app shell only owns the <main> landmark on the "/" route; every other
    // route (like this one) supplies its own, matching SettingsPage/AdminPage.
    <main className="flex min-h-full flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("sharedMailboxes.title")}</h1>
        <Link to="/" className="text-sm text-accent-text underline">
          {t("settings.back")}
        </Link>
      </div>
      <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
        {body}
      </section>
    </main>
  );
}
