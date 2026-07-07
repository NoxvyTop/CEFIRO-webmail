import { type FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { CreateUserInput } from "@webmail/shared";
import { createAdminUser, fetchAdminUsers } from "./api";
import { UserRow } from "./UserRow";

const USERS_QUERY_KEY = ["admin", "users"] as const;

type NewUserForm = { email: string; displayName: string; role: "employee" | "admin"; mailPassword: string };

const EMPTY_NEW_USER: NewUserForm = { email: "", displayName: "", role: "employee", mailPassword: "" };

export function AdminPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const usersQuery = useQuery({ queryKey: USERS_QUERY_KEY, queryFn: fetchAdminUsers });

  const [newUser, setNewUser] = useState(EMPTY_NEW_USER);

  const createMutation = useMutation({
    mutationFn: (input: CreateUserInput) => createAdminUser(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      setNewUser(EMPTY_NEW_USER);
    },
  });

  function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    const input: CreateUserInput = {
      email: newUser.email,
      displayName: newUser.displayName,
      role: newUser.role,
      locale: "es",
      ...(newUser.mailPassword ? { mailPassword: newUser.mailPassword } : {}),
    };
    createMutation.mutate(input);
  }

  const users = usersQuery.data ?? [];

  return (
    <main aria-label={t("admin.title")} className="flex flex-col gap-6 p-6">
      <h1 className="text-lg font-semibold">{t("admin.title")}</h1>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium">{t("admin.new.title")}</h2>
        <form onSubmit={handleCreateSubmit} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.new.email")}
            <input
              type="email"
              required
              value={newUser.email}
              onChange={(event) => setNewUser({ ...newUser, email: event.target.value })}
              className="rounded-md border p-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.new.name")}
            <input
              required
              value={newUser.displayName}
              onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })}
              className="rounded-md border p-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.new.role")}
            <select
              value={newUser.role}
              onChange={(event) =>
                setNewUser({ ...newUser, role: event.target.value as "employee" | "admin" })
              }
              className="rounded-md border p-1"
            >
              <option value="employee">{t("admin.roles.employee")}</option>
              <option value="admin">{t("admin.roles.admin")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.new.mailPassword")}
            <input
              type="password"
              minLength={8}
              value={newUser.mailPassword}
              onChange={(event) => setNewUser({ ...newUser, mailPassword: event.target.value })}
              className="rounded-md border p-1"
            />
          </label>
          <button type="submit" className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white">
            {t("admin.new.create")}
          </button>
        </form>
        {createMutation.isError && (
          <p role="alert" className="text-sm text-red-600">
            {t("admin.errors.action")}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        {usersQuery.isError && (
          <p role="alert" className="text-sm text-red-600">
            {t("admin.errors.load")}
          </p>
        )}
        {!usersQuery.isError && !usersQuery.isLoading && users.length === 0 && (
          <p>{t("admin.empty")}</p>
        )}
        {users.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="p-2 text-left">{t("admin.columns.email")}</th>
                <th className="p-2 text-left">{t("admin.columns.name")}</th>
                <th className="p-2 text-left">{t("admin.columns.role")}</th>
                <th className="p-2 text-left">{t("admin.columns.mailbox")}</th>
                <th className="p-2 text-left">{t("admin.columns.status")}</th>
                <th className="p-2 text-left">{t("admin.columns.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <UserRow key={user.id} user={user} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
