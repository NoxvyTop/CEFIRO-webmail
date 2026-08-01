import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AdminUser, AdminUsersPage } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AdminPage } from "./AdminPage";
import { adminErrorKey } from "./errors";
import { MailApiError } from "../mailbox/api";

// GH #46. The hardening added three 409 guardrails whose entire value is
// EXPLAINING a refusal — and the console answered all of them, plus a dead
// database, plus a duplicate address, with the same "the action could not be
// completed". An admin who is told nothing cannot tell a rule from a bug.

const {
  fetchAdminUsers, createAdminUser, setUserRole, setUserActive, setUserCredential,
  fetchAdminSso, updateAdminSso, fetchAdminInstance, updateAdminInstance,
} = vi.hoisted(() => ({
  fetchAdminUsers: vi.fn(),
  createAdminUser: vi.fn(),
  setUserRole: vi.fn(),
  setUserActive: vi.fn(),
  setUserCredential: vi.fn(),
  fetchAdminSso: vi.fn().mockResolvedValue({
    configured: false, issuer: null, clientId: null, scopes: null,
  }),
  updateAdminSso: vi.fn(),
  fetchAdminInstance: vi.fn().mockResolvedValue({ sentWithFooter: false }),
  updateAdminInstance: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchAdminUsers, createAdminUser, setUserRole, setUserActive, setUserCredential,
  fetchAdminSso, updateAdminSso, fetchAdminInstance, updateAdminInstance,
}));

const employee: AdminUser = {
  id: "u2",
  email: "emp@example.com",
  displayName: "Employee Two",
  role: "employee",
  locale: "es",
  active: true,
  mailboxLinked: false,
};

const admin: AdminUser = { ...employee, id: "u1", email: "admin@example.com", role: "admin" };

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

function renderUsersSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.nav.users") }));
}

async function rowFor(email: string): Promise<HTMLElement> {
  return (await screen.findByText(email)).closest("tr") as HTMLElement;
}

describe("adminErrorKey", () => {
  it.each(["last_admin", "self_archive", "self_demotion", "user_exists", "forbidden"])(
    "maps %s to its own message",
    (code) => {
      expect(adminErrorKey(new MailApiError(409, code))).toBe(`admin.errors.${code}`);
    },
  );

  it("falls back to the generic message for a code with no message of its own", () => {
    expect(adminErrorKey(new MailApiError(500, "jmap_error"))).toBe("admin.errors.generic");
  });

  it("falls back to generic for an error that never reached the server", () => {
    expect(adminErrorKey(new TypeError("Failed to fetch"))).toBe("admin.errors.generic");
  });
});

describe("the admin console explains WHY an action was refused (GH #46)", () => {
  it("names the last-admin block when a demotion is refused", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage([admin]));
    setUserRole.mockRejectedValue(new MailApiError(409, "last_admin"));
    renderUsersSection();

    const row = await rowFor("admin@example.com");
    fireEvent.change(within(row).getByRole("combobox", { name: i18n.t("admin.actions.role") }), {
      target: { value: "employee" },
    });

    expect(
      await within(row).findByText(i18n.t("admin.errors.last_admin")),
    ).toBeInTheDocument();
  });

  it("names the self-demotion block", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage([admin]));
    setUserRole.mockRejectedValue(new MailApiError(409, "self_demotion"));
    renderUsersSection();

    const row = await rowFor("admin@example.com");
    fireEvent.change(within(row).getByRole("combobox", { name: i18n.t("admin.actions.role") }), {
      target: { value: "employee" },
    });

    expect(
      await within(row).findByText(i18n.t("admin.errors.self_demotion")),
    ).toBeInTheDocument();
  });

  it("names the self-archive block", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage([admin]));
    setUserActive.mockRejectedValue(new MailApiError(409, "self_archive"));
    renderUsersSection();

    const row = await rowFor("admin@example.com");
    // Archiving is two clicks: the first arms the confirmation.
    fireEvent.click(within(row).getByRole("button", { name: i18n.t("admin.actions.archive") }));
    fireEvent.click(
      within(row).getByRole("button", { name: i18n.t("admin.actions.confirmArchive") }),
    );

    expect(
      await within(row).findByText(i18n.t("admin.errors.self_archive")),
    ).toBeInTheDocument();
  });

  it("still says something for a failure that carries no code", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage([employee]));
    setUserRole.mockRejectedValue(new Error("boom"));
    renderUsersSection();

    const row = await rowFor("emp@example.com");
    fireEvent.change(within(row).getByRole("combobox", { name: i18n.t("admin.actions.role") }), {
      target: { value: "admin" },
    });

    expect(await within(row).findByText(i18n.t("admin.errors.generic"))).toBeInTheDocument();
  });

  it("names the duplicate address when creating a user that already exists", async () => {
    fetchAdminUsers.mockResolvedValue(usersPage([]));
    createAdminUser.mockRejectedValue(new MailApiError(409, "user_exists"));
    renderUsersSection();

    await screen.findByText(i18n.t("admin.empty"));
    fireEvent.change(screen.getByLabelText(i18n.t("admin.new.email")), {
      target: { value: "taken@example.com" },
    });
    fireEvent.change(screen.getByLabelText(i18n.t("admin.new.name")), {
      target: { value: "Taken" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.new.create") }));

    expect(await screen.findByText(i18n.t("admin.errors.user_exists"))).toBeInTheDocument();
  });
});
