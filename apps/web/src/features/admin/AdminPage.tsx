import { type FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { AdminUser, CreateUserInput } from "@webmail/shared";
import {
  createAdminUser, fetchAdminInstance, fetchAdminSso, fetchAdminUsers,
  updateAdminInstance, updateAdminSso,
} from "./api";
import { MailboxGauge } from "./MailboxGauge";
import { UserRow } from "./UserRow";

const inputClass =
  "h-11 rounded-input border border-line bg-soft px-3 text-ink field-focus";

const primaryButtonClass =
  "flex h-11 items-center rounded-[11px] bg-accent px-4 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]";

const paginationButtonClass =
  "flex h-9 items-center rounded-[9px] border border-line px-3 text-xs font-semibold transition hover:bg-hover disabled:opacity-50";

// Canonical secondary button (same visual language as the reader's
// Responder/Reenviar/Archivar buttons, see ThreadView.tsx:389).
const secondaryButtonClass =
  "flex h-[38px] items-center gap-2 rounded-[10px] border border-line bg-panel px-[18px] text-[13.5px] font-semibold text-ink transition hover:bg-hover";

const USERS_QUERY_KEY = ["admin", "users"] as const;
const SSO_QUERY_KEY = ["admin", "sso"] as const;
const INSTANCE_QUERY_KEY = ["admin", "instance"] as const;
const USERS_PAGE_SIZE = 25;

type Section = "resumen" | "users" | "sso" | "settings";

const NAV_ITEMS: { id: Section; labelKey: string }[] = [
  { id: "resumen", labelKey: "admin.nav.resumen" },
  { id: "users", labelKey: "admin.nav.users" },
  { id: "sso", labelKey: "admin.nav.sso" },
  { id: "settings", labelKey: "admin.nav.settings" },
];

const metricCardClass = "rounded-[14px] border border-line bg-panel p-5";
const metricLabelClass = "text-[11px] font-bold uppercase tracking-[0.12em] text-muted";
const metricValueClass = "mt-1 text-[27px] font-semibold tracking-tight tabular-nums";
// Big "banner" figure for the standalone metric cards (fills the full-width
// stretched cards); the gauge card keeps the smaller metricValueClass.
const metricBannerClass = "mt-2 text-[40px] font-semibold leading-none tracking-tight tabular-nums";
const metricStatClass = `${metricCardClass} flex flex-col justify-center`;

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
  const instanceQuery = useQuery({ queryKey: INSTANCE_QUERY_KEY, queryFn: fetchAdminInstance });

  const [newUser, setNewUser] = useState(EMPTY_NEW_USER);
  const [ssoForm, setSsoForm] = useState(EMPTY_SSO_FORM);
  const [userSearch, setUserSearch] = useState("");
  const [userPage, setUserPage] = useState(0);
  const [section, setSection] = useState<Section>("resumen");

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

  const instanceMutation = useMutation({
    mutationFn: (input: { sentWithFooter: boolean }) => updateAdminInstance(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY }),
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

  const metrics = useMemo(() => {
    const total = users.length;
    const active = users.filter((user) => user.active).length;
    const archived = total - active;
    const mailboxLinked = users.filter((user) => user.mailboxLinked).length;
    return { total, active, archived, mailboxLinked };
  }, [users]);

  function handleUserSearchChange(value: string) {
    setUserSearch(value);
    setUserPage(0);
  }

  return (
    <main aria-label={t("admin.title")} className="flex min-h-full flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("admin.title")}</h1>
        <Link to="/" className={secondaryButtonClass}>
          {t("admin.back")}
        </Link>
      </div>

      <div className="flex flex-1 flex-col gap-6 md:flex-row md:items-start">
        <nav
          aria-label={t("admin.nav.label")}
          className="flex w-full shrink-0 flex-row gap-1 rounded-[14px] border border-line bg-panel p-3 md:w-[184px] md:flex-col"
        >
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
              className={`rounded-[10px] px-3 py-2 text-left text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-accent ${
                section === item.id ? "bg-sel text-accent-text" : "text-ink hover:bg-hover"
              }`}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {section === "resumen" && (
            <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
              <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3">
                <div className={metricStatClass}>
                  <p className={metricLabelClass}>{t("admin.metrics.users")}</p>
                  <p className={`${metricBannerClass} text-ink`}>{metrics.total}</p>
                </div>
                <div className={metricStatClass}>
                  <p className={metricLabelClass}>{t("admin.metrics.active")}</p>
                  <p className={`${metricBannerClass} text-accent-text`}>
                    {metrics.active}
                    <span className="ml-2 text-base font-medium text-muted">
                      {t("admin.metrics.archivedSuffix", { count: metrics.archived })}
                    </span>
                  </p>
                </div>
                <div className={metricStatClass}>
                  <p className={metricLabelClass}>{t("admin.metrics.sso")}</p>
                  <p className={`mt-2 text-[26px] font-semibold leading-none ${sso?.configured ? "text-accent-text" : "text-ink"}`}>
                    {sso
                      ? sso.configured
                        ? t("admin.sso.configured")
                        : t("admin.sso.notConfigured")
                      : ssoQuery.isError
                        ? "—"
                        : null}
                  </p>
                </div>
              </div>

              <div className={`${metricCardClass} flex items-center gap-4 lg:w-[340px] lg:shrink-0`}>
                <MailboxGauge linked={metrics.mailboxLinked} total={metrics.total} />
                <div>
                  <p className={metricLabelClass}>{t("admin.metrics.mailboxGaugeTitle")}</p>
                  <p className={`${metricValueClass} text-ink`}>
                    {t("admin.metrics.mailboxGaugeRatio", { linked: metrics.mailboxLinked, total: metrics.total })}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {t("admin.metrics.unlinkedCount", { count: metrics.total - metrics.mailboxLinked })}
                  </p>
                </div>
              </div>
            </div>
          )}

          {section === "users" && (
            <>
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
                                <th className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.name")}</th>
                                <th className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.role")}</th>
                                <th className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.mailbox")}</th>
                                <th className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.status")}</th>
                                <th className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{t("admin.columns.actions")}</th>
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
            </>
          )}

          {section === "sso" && (
            <section className="flex flex-col gap-4 rounded-[14px] border border-line bg-panel p-5">
              <h2 className="text-lg font-medium">{t("admin.sso.title")}</h2>

              {sso && (
                <div className="flex flex-col gap-3 rounded-[14px] border border-line bg-soft p-4">
                  <span
                    className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      sso.configured ? "bg-sel text-accent-text" : "border border-line text-muted"
                    }`}
                  >
                    {sso.configured ? t("admin.sso.configured") : t("admin.sso.notConfigured")}
                  </span>
                  {sso.configured && (
                    <dl className="flex flex-col gap-2">
                      {sso.issuer && (
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
                            {t("admin.sso.fields.issuer")}
                          </dt>
                          <dd className="text-sm text-ink">{sso.issuer}</dd>
                        </div>
                      )}
                      {sso.clientId && (
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
                            {t("admin.sso.fields.clientId")}
                          </dt>
                          <dd className="text-sm text-ink">{sso.clientId}</dd>
                        </div>
                      )}
                      {sso.scopes && (
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
                            {t("admin.sso.fields.scopes")}
                          </dt>
                          <dd className="text-sm text-ink">{sso.scopes}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                </div>
              )}

              <form
                onSubmit={handleSsoSubmit}
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
              >
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
                <button type="submit" className={`${primaryButtonClass} justify-center sm:col-span-2 lg:col-span-4`}>
                  {t("admin.sso.save")}
                </button>
              </form>
              {ssoMutation.isSuccess && <p className="text-sm text-accent-text">{t("admin.sso.saved")}</p>}
              {ssoMutation.isError && (
                <p role="alert" className="text-sm text-danger">
                  {t("admin.sso.error")}
                </p>
              )}
            </section>
          )}

          {section === "settings" && (
            <section className="flex flex-col gap-4 rounded-[14px] border border-line bg-panel p-5">
              <h2 className="text-lg font-medium">{t("admin.settings.title")}</h2>
              <div className="flex items-start gap-3 rounded-[14px] border border-line bg-soft p-4">
                <input
                  id="instance-footer-toggle"
                  type="checkbox"
                  checked={instanceQuery.data?.sentWithFooter ?? false}
                  onChange={(event) => instanceMutation.mutate({ sentWithFooter: event.target.checked })}
                  aria-describedby="instance-footer-toggle-description"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-line accent-accent"
                />
                <div className="flex flex-col gap-0.5">
                  <label htmlFor="instance-footer-toggle" className="text-sm font-medium text-ink">
                    {t("admin.settings.footer.label")}
                  </label>
                  <p id="instance-footer-toggle-description" className="text-xs text-muted">
                    {t("admin.settings.footer.description")}
                  </p>
                </div>
              </div>
              {instanceMutation.isError && (
                <p role="alert" className="text-sm text-danger">
                  {t("admin.errors.action")}
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
