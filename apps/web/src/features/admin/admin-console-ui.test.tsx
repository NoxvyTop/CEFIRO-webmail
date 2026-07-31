import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AdminSsoView, AdminUser, AdminUsersPage } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AdminPage } from "./AdminPage";

// GH #153: fetchAdminUsers now resolves a page envelope. The Resumen metrics
// read the tenant-wide `stats`, so derive them here from the fixture list.
function usersPage(users: AdminUser[]): AdminUsersPage {
  return {
    users,
    total: users.length,
    stats: {
      total: users.length,
      active: users.filter((u) => u.active).length,
      mailboxLinked: users.filter((u) => u.mailboxLinked).length,
    },
  };
}

const {
  fetchAdminUsers, createAdminUser, setUserRole, setUserActive, setUserCredential,
  fetchAdminSso, updateAdminSso, fetchAdminInstance, updateAdminInstance,
} = vi.hoisted(() => ({
  fetchAdminUsers: vi.fn(),
  createAdminUser: vi.fn(),
  setUserRole: vi.fn(),
  setUserActive: vi.fn(),
  setUserCredential: vi.fn(),
  fetchAdminSso: vi.fn(),
  updateAdminSso: vi.fn(),
  fetchAdminInstance: vi.fn(),
  updateAdminInstance: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchAdminUsers, createAdminUser, setUserRole, setUserActive, setUserCredential,
  fetchAdminSso, updateAdminSso, fetchAdminInstance, updateAdminInstance,
}));

function makeUser(overrides: Partial<AdminUser>): AdminUser {
  return {
    id: "u1",
    email: "user@example.com",
    displayName: "User",
    role: "employee",
    locale: "es",
    active: true,
    mailboxLinked: true,
    ...overrides,
  };
}

const threeUsers: AdminUser[] = [
  makeUser({ id: "u1", email: "a@example.com", displayName: "A", active: true, mailboxLinked: true }),
  makeUser({ id: "u2", email: "b@example.com", displayName: "B", active: true, mailboxLinked: true }),
  makeUser({ id: "u3", email: "c@example.com", displayName: "C", active: false, mailboxLinked: false }),
];

const configuredSso: AdminSsoView = {
  configured: true,
  issuer: "https://auth.test",
  clientId: "webmail",
  scopes: "openid email",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

describe("AdminPage console shell", () => {
  it("defaults to the Resumen section with derived metric cards, and hides other sections' content", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage(threeUsers));
    fetchAdminSso.mockResolvedValue(configuredSso);
    fetchAdminInstance.mockResolvedValue({ sentWithFooter: false });
    renderPage();

    const nav = await screen.findByRole("navigation", { name: i18n.t("admin.nav.label") });
    expect(within(nav).getByRole("button", { name: i18n.t("admin.nav.resumen") })).toHaveAttribute(
      "aria-current",
      "page",
    );

    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("admin.metrics.archivedSuffix", { count: 1 })),
    ).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("admin.metrics.mailboxGaugeRatio", { linked: 2, total: 3 })),
    ).toBeInTheDocument();
    expect(screen.getByText(i18n.t("admin.sso.configured"))).toBeInTheDocument();

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("admin.sso.title"))).not.toBeInTheDocument();
  });

  it("shows the mailbox-linked gauge card with the derived percentage and unlinked count", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage([
      makeUser({ id: "u1", email: "a@example.com", mailboxLinked: true }),
      makeUser({ id: "u2", email: "b@example.com", mailboxLinked: true }),
      makeUser({ id: "u3", email: "c@example.com", mailboxLinked: true }),
      makeUser({ id: "u4", email: "d@example.com", mailboxLinked: false }),
    ]));
    fetchAdminSso.mockResolvedValue(configuredSso);
    fetchAdminInstance.mockResolvedValue({ sentWithFooter: false });
    renderPage();

    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("admin.metrics.mailboxGaugeTitle"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("admin.metrics.unlinkedCount", { count: 1 }))).toBeInTheDocument();
  });

  it("shows Sin configurar and a 0 archived suffix for a fully-active tenant without SSO", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage([
      makeUser({ id: "u1", email: "a@example.com", active: true, mailboxLinked: true }),
    ]));
    fetchAdminSso.mockResolvedValue({ configured: false, issuer: null, clientId: null, scopes: null });
    fetchAdminInstance.mockResolvedValue({ sentWithFooter: false });
    renderPage();

    expect(await screen.findByText(i18n.t("admin.sso.notConfigured"))).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("admin.metrics.archivedSuffix", { count: 0 })),
    ).toBeInTheDocument();
  });

  it("switches to Usuarios and shows the existing users table", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage(threeUsers));
    fetchAdminSso.mockResolvedValue(configuredSso);
    fetchAdminInstance.mockResolvedValue({ sentWithFooter: false });
    renderPage();

    await screen.findByText("3");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.nav.users") }));

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByText("a@example.com")).toBeInTheDocument();
  });

  it("switches to Identidad (SSO) and shows the existing SSO form", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage(threeUsers));
    fetchAdminSso.mockResolvedValue(configuredSso);
    fetchAdminInstance.mockResolvedValue({ sentWithFooter: false });
    renderPage();

    await screen.findByText("3");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.nav.sso") }));

    expect(await screen.findByText(i18n.t("admin.sso.title"))).toBeInTheDocument();
    expect(screen.getByLabelText("Issuer")).toBeInTheDocument();
  });

  it("switches to Ajustes and shows the sent-with-footer toggle, off by default", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage(threeUsers));
    fetchAdminSso.mockResolvedValue(configuredSso);
    fetchAdminInstance.mockResolvedValue({ sentWithFooter: false });
    renderPage();

    await screen.findByText("3");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.nav.settings") }));

    expect(await screen.findByText(i18n.t("admin.settings.title"))).toBeInTheDocument();
    const toggle = screen.getByLabelText(i18n.t("admin.settings.footer.label"));
    expect(toggle).not.toBeChecked();
  });
});
