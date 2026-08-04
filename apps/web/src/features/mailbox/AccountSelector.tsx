import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { ACTIVE_ACCOUNT_PARAM, fetchSharedAccounts } from "./api";

// GH #13/#50: switching the active mailbox changes which JMAP account every
// mail query runs against, so the ids scoping the previous view (folder,
// thread, label, starred, group, search) no longer mean anything — they are
// cleared so the new account opens on its own inbox.
const VIEW_PARAMS_TO_RESET = ["mailbox", "thread", "label", "starred", "group", "q"];

/**
 * GH #13/#50 — Option 1 (the design's MVP): a header chip/dropdown that lists
 * the personal mailbox plus every shared mailbox the member can access
 * (GET /api/mail/shared-accounts), and switches the WHOLE mail view to the one
 * chosen. The choice lives in the `account` URL param, which MailPage threads
 * into every mail query key and request; personal = no param, one mailbox at a
 * time.
 *
 * Renders nothing when the member has no shared mailboxes — the common case —
 * so the header and the personal experience are unchanged for everyone else.
 */
export function AccountSelector() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const sharedAccountsQuery = useQuery({
    queryKey: ["mail", "shared-accounts"],
    queryFn: fetchSharedAccounts,
  });
  const sharedAccounts = sharedAccountsQuery.data ?? [];
  const activeAccountId = searchParams.get(ACTIVE_ACCOUNT_PARAM);

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Nothing to switch between: keep the header clean and the personal
  // experience byte-identical for members without shared mailboxes.
  if (sharedAccounts.length === 0) return null;

  function selectAccount(accountId: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (accountId) {
        next.set(ACTIVE_ACCOUNT_PARAM, accountId);
      } else {
        next.delete(ACTIVE_ACCOUNT_PARAM);
      }
      for (const key of VIEW_PARAMS_TO_RESET) next.delete(key);
      return next;
    });
    setOpen(false);
  }

  const activeName =
    sharedAccounts.find((account) => account.id === activeAccountId)?.name ?? t("accounts.personal");

  function renderOption(id: string | null, label: string) {
    const checked = id === null ? !activeAccountId : id === activeAccountId;
    return (
      <button
        key={id ?? "__personal__"}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        onClick={() => selectAccount(id)}
        className={`flex h-9 w-full items-center px-3 text-left text-sm hover:bg-hover ${
          checked ? "bg-sel font-[650]" : "text-ink"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("accounts.selectorLabel")}
        onClick={() => setOpen((current) => !current)}
        className="flex h-[34px] max-w-[180px] shrink-0 items-center gap-[7px] rounded-[8px] border border-line px-3 text-[13px] text-ink transition hover:bg-hover"
      >
        <span className="min-w-0 truncate">{activeName}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0 opacity-60"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("accounts.selectorLabel")}
          className="absolute right-0 z-50 mt-1.5 flex min-w-[200px] max-w-[280px] flex-col rounded-[12px] border border-line bg-panel py-1 shadow-pop"
        >
          {renderOption(null, t("accounts.personal"))}
          <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
            {t("accounts.sharedHeading")}
          </p>
          {sharedAccounts.map((account) => renderOption(account.id, account.name))}
        </div>
      )}
    </div>
  );
}
