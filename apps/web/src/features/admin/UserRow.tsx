import { type FormEvent, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AdminUser } from "@webmail/shared";
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

  return (
    <tr className="border-t border-line">
      <td className="p-2">{user.email}</td>
      <td className="p-2">{user.displayName}</td>
      <td className="p-2">
        <select
          aria-label={t("admin.actions.role")}
          value={user.role}
          onChange={(event) => roleMutation.mutate(event.target.value as "employee" | "admin")}
          className="rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"
        >
          <option value="employee">{t("admin.roles.employee")}</option>
          <option value="admin">{t("admin.roles.admin")}</option>
        </select>
      </td>
      <td className="p-2">
        {user.mailboxLinked ? t("admin.mailbox.linked") : t("admin.mailbox.unlinked")}
      </td>
      <td className="p-2">{user.active ? t("admin.status.active") : t("admin.status.archived")}</td>
      <td className="p-2">
        <div className="flex flex-col items-start gap-1">
          {!credentialOpen && (
            <button type="button" onClick={() => setCredentialOpen(true)} className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover">
              {t("admin.actions.linkMailbox")}
            </button>
          )}
          {credentialOpen && (
            <form onSubmit={handleCredentialSubmit} className="flex gap-1">
              <input
                type="password"
                aria-label={t("admin.actions.linkMailbox")}
                minLength={8}
                required
                value={mailPassword}
                onChange={(event) => setMailPassword(event.target.value)}
                className="rounded-md border border-line bg-soft p-1 text-xs text-ink outline-none focus:border-accent"
              />
              <button type="submit" className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover">
                {t("admin.actions.saveCredential")}
              </button>
            </form>
          )}
          <button type="button" onClick={handleArchiveClick} className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover">
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
