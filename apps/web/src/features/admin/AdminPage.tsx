import { type FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { AdminUser, CreateUserInput } from "@webmail/shared";
import { createAdminUser, fetchAdminSso, fetchAdminUsers, updateAdminSso } from "./api";
import { UserRow } from "./UserRow";

const inputClass =
  "h-11 rounded-input border border-line bg-soft px-3 text-ink outline-none focus:border-accent";

const primaryButtonClass =
  "flex h-11 items-center rounded-[11px] bg-accent px-4 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]";

const paginationButtonClass =
  "flex h-9 items-center rounded-[9px] border border-line px-3 text-xs font-semibold transition hover:bg-hover disabled:opacity-50";

const USERS_QUERY_KEY = ["admin", "users"] as const;
const SSO_QUERY_KEY = ["admin", "sso"] as const;
const USERS_PAGE_SIZE = 25;

function filterUsers(users: AdminUser[], term: string): AdminUser[] {
  const normalized = term.trim().toLowerCase();
  if (!normalized) return users;
  return users.filter(
    (user) =>
      user.email.toLowerCase().includes(normalized) || user.displayName.toLowerCase().includes(normalized),
  );
}

type NewUserForm = { email: string; displayName: string; role: "employee" | "admin"; mailPassword: string };

const EMPTY_NEW_USER: NewUserForm = { email: "", displayName: "", role: "employee", mailPassword: "" };

type SsoForm = { issuer: string; clientId: string; clientSecret: string; scopes: string };

const EMPTY_SSO_FORM: SsoForm = { issuer: "", clientId: "", clientSecret: "", scopes: "" };

export function AdminPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const usersQuery = useQuery({ queryKey: USERS_QUERY_KEY, queryFn: fetchAdminUsers });
  const ssoQuery = useQuery({ queryKey: SSO_QUERY_KEY, queryFn: fetchAdminSso });

  const [newUser, setNewUser] = useState(EMPTY_NEW_USER);
  const [ssoForm, setSsoForm] = useState(EMPTY_SSO_FORM);
  const [userSearch, setUserSearch] = useState("");
  const [userPage, setUserPage] = useState(0);

  const createMutation = useMutation({
    mutationFn: (input: CreateUserInput) => createAdminUser(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      setNewUser(EMPTY_NEW_USER);
    },
  });

  const ssoMutation = useMutation({
    mutationFn: (input: SsoForm) => updateAdminSso(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SSO_QUERY_KEY });
      setSsoForm(EMPTY_SSO_FORM);
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

  function handleSsoSubmit(event: FormEvent) {
    event.preventDefault();
    ssoMutation.mutate(ssoForm);
  }

  const users = usersQuery.data ?? [];
  const sso = ssoQuery.data;

  const filteredUsers = useMemo(() => filterUsers(users, userSearch), [users, userSearch]);
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / USERS_PAGE_SIZE));
  const currentPage = Math.min(userPage, pageCount - 1);
  const pageStart = currentPage * USERS_PAGE_SIZE;
  const pagedUsers = filteredUsers.slice(pageStart, pageStart + USERS_PAGE_SIZE);

  function handleUserSearchChange(value: string) {
    setUserSearch(value);
    setUserPage(0);
  }

  return (
    <main aria-label={t("admin.title")} className="mx-auto flex min-h-full max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("admin.title")}</h1>
        <Link to="/" className="text-sm text-accent underline">
          {t("admin.back")}
        </Link>
      </div>

      <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
        <h2 className="text-lg font-medium">{t("admin.new.title")}</h2>
        <form onSubmit={handleCreateSubmit} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.new.email")}
            <input
              type="email"
              required
              value={newUser.email}
              onChange={(event) => setNewUser({ ...newUser, email: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.new.name")}
            <input
              required
              value={newUser.displayName}
              onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.new.role")}
            <select
              value={newUser.role}
              onChange={(event) =>
                setNewUser({ ...newUser, role: event.target.value as "employee" | "admin" })
              }
              className={inputClass}
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
              className={inputClass}
            />
          </label>
          <button type="submit" className={primaryButtonClass}>
            {t("admin.new.create")}
          </button>
        </form>
        {createMutation.isError && (
          <p role="alert" className="text-sm text-danger">
            {t("admin.errors.action")}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
        {usersQuery.isError && (
          <p role="alert" className="text-sm text-danger">
            {t("admin.errors.load")}
          </p>
        )}
        {!usersQuery.isError && !usersQuery.isLoading && users.length === 0 && (
          <p>{t("admin.empty")}</p>
        )}
        {users.length > 0 && (
          <>
            <input
              type="search"
              value={userSearch}
              onChange={(event) => handleUserSearchChange(event.target.value)}
              placeholder={t("admin.search.placeholder")}
              aria-label={t("admin.search.placeholder")}
              className={`${inputClass} w-full max-w-xs`}
            />
            {filteredUsers.length === 0 ? (
              <p>{t("admin.search.noResults")}</p>
            ) : (
              <>
                <div className="overflow-x-auto rounded-[10px] border border-line">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr>
                        <th className="p-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.email")}</th>
                        <th className="p-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.name")}</th>
                        <th className="p-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.role")}</th>
                        <th className="p-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.mailbox")}</th>
                        <th className="p-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.status")}</th>
                        <th className="p-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedUsers.map((user) => (
                        <UserRow key={user.id} user={user} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted">
                    {t("admin.pagination.range", {
                      from: pageStart + 1,
                      to: pageStart + pagedUsers.length,
                      total: filteredUsers.length,
                    })}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setUserPage(Math.max(0, currentPage - 1))}
                      disabled={currentPage === 0}
                      className={paginationButtonClass}
                    >
                      {t("admin.pagination.prev")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setUserPage(Math.min(pageCount - 1, currentPage + 1))}
                      disabled={currentPage >= pageCount - 1}
                      className={paginationButtonClass}
                    >
                      {t("admin.pagination.next")}
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5">
        <h2 className="text-lg font-medium">{t("admin.sso.title")}</h2>

        {sso && (
          <div className="flex flex-col gap-1 text-sm">
            <p>{sso.configured ? t("admin.sso.configured") : t("admin.sso.notConfigured")}</p>
            {sso.configured && (
              <dl className="flex flex-col gap-1">
                {sso.issuer && (
                  <div className="flex gap-2">
                    <dt className="font-medium">{t("admin.sso.fields.issuer")}</dt>
                    <dd>{sso.issuer}</dd>
                  </div>
                )}
                {sso.clientId && (
                  <div className="flex gap-2">
                    <dt className="font-medium">{t("admin.sso.fields.clientId")}</dt>
                    <dd>{sso.clientId}</dd>
                  </div>
                )}
                {sso.scopes && (
                  <div className="flex gap-2">
                    <dt className="font-medium">{t("admin.sso.fields.scopes")}</dt>
                    <dd>{sso.scopes}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        )}

        <form onSubmit={handleSsoSubmit} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.sso.fields.issuer")}
            <input
              value={ssoForm.issuer}
              onChange={(event) => setSsoForm({ ...ssoForm, issuer: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.sso.fields.clientId")}
            <input
              value={ssoForm.clientId}
              onChange={(event) => setSsoForm({ ...ssoForm, clientId: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.sso.fields.clientSecret")}
            <input
              type="password"
              value={ssoForm.clientSecret}
              onChange={(event) => setSsoForm({ ...ssoForm, clientSecret: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("admin.sso.fields.scopes")}
            <input
              value={ssoForm.scopes}
              onChange={(event) => setSsoForm({ ...ssoForm, scopes: event.target.value })}
              className={inputClass}
            />
          </label>
          <button type="submit" className={primaryButtonClass}>
            {t("admin.sso.save")}
          </button>
        </form>
        {ssoMutation.isSuccess && <p>{t("admin.sso.saved")}</p>}
        {ssoMutation.isError && (
          <p role="alert" className="text-sm text-danger">
            {t("admin.sso.error")}
          </p>
        )}
      </section>
    </main>
  );
}
