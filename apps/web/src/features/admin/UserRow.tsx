import { type FormEvent, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AdminUser } from "@webmail/shared";
import { Avatar } from "../../app/ui/Avatar";
import { setUserActive, setUserCredential, setUserRole } from "./api";

const USERS_QUERY_KEY = ["admin", "users"] as const;

export function UserRow({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [mailPassword, setMailPassword] = useState("");
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  function invalidateUsers() {
    return queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
  }

  const roleMutation = useMutation({
    mutationFn: (role: "employee" | "admin") => setUserRole(user.id, role),
    onSuccess: () => invalidateUsers(),
  });

  const activeMutation = useMutation({
    mutationFn: (active: boolean) => setUserActive(user.id, active),
    onSuccess: async () => {
      setConfirmingArchive(false);
      await invalidateUsers();
    },
  });

  const credentialMutation = useMutation({
    mutationFn: (password: string) => setUserCredential(user.id, password),
    onSuccess: async () => {
      setCredentialOpen(false);
      setMailPassword("");
      await invalidateUsers();
    },
  });

  const hasError = roleMutation.isError || activeMutation.isError || credentialMutation.isError;

  function handleCredentialSubmit(event: FormEvent) {
    event.preventDefault();
    credentialMutation.mutate(mailPassword);
  }

  function handleArchiveClick() {
    if (!user.active) {
      activeMutation.mutate(true);
      return;
    }
    if (confirmingArchive) {
      activeMutation.mutate(false);
    } else {
      setConfirmingArchive(true);
    }
  }

  const archiveLabel = confirmingArchive
    ? t("admin.actions.confirmArchive")
    : user.active
      ? t("admin.actions.archive")
      : t("admin.actions.reactivate");

  // Compact variant of the app's canonical secondary button (same visual
  // language as the reader's Responder/Reenviar/Archivar, see
  // ThreadView.tsx:389), sized to fit inline in a table row.
  const compactSecondaryButtonClass =
    "flex h-8 items-center rounded-[9px] border border-line bg-panel px-3 text-xs font-semibold text-ink transition hover:bg-hover disabled:opacity-50";

  return (
    <tr className="border-t border-line transition hover:bg-hover">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <Avatar name={user.displayName} email={user.email} size={30} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-ink">{user.displayName}</span>
            <span className="truncate text-xs text-muted">{user.email}</span>
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <select
          aria-label={t("admin.actions.role")}
          value={user.role}
          onChange={(event) => roleMutation.mutate(event.target.value as "employee" | "admin")}
          className="h-8 rounded-[8px] border border-line bg-soft px-2 text-xs font-medium text-ink outline-none focus:border-accent"
        >
          <option value="employee">{t("admin.roles.employee")}</option>
          <option value="admin">{t("admin.roles.admin")}</option>
        </select>
      </td>
      <td className="px-3 py-2.5">
        {user.mailboxLinked ? (
          <span className="text-xs text-muted">{t("admin.mailbox.linked")}</span>
        ) : (
          <span className="inline-flex items-center rounded-full border border-warn/40 px-2 py-0.5 text-xs font-medium text-warn">
            {t("admin.mailbox.unlinked")}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            user.active ? "bg-sel text-accent-text" : "border border-line text-muted"
          }`}
        >
          {user.active ? t("admin.status.active") : t("admin.status.archived")}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-col items-start gap-1">
          {!credentialOpen && (
            <button type="button" onClick={() => setCredentialOpen(true)} className={compactSecondaryButtonClass}>
              {t("admin.actions.linkMailbox")}
            </button>
          )}
          {credentialOpen && (
            <form onSubmit={handleCredentialSubmit} className="flex items-center gap-1">
              <input
                type="password"
                aria-label={t("admin.actions.linkMailbox")}
                minLength={8}
                required
                value={mailPassword}
                onChange={(event) => setMailPassword(event.target.value)}
                className="h-8 rounded-[9px] border border-line bg-soft px-3 text-xs text-ink outline-none focus:border-accent"
              />
              <button type="submit" className={compactSecondaryButtonClass}>
                {t("admin.actions.saveCredential")}
              </button>
            </form>
          )}
          <button type="button" onClick={handleArchiveClick} className={compactSecondaryButtonClass}>
            {archiveLabel}
          </button>
          {hasError && (
            <p role="alert" className="text-xs text-danger">
              {t("admin.errors.action")}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}
