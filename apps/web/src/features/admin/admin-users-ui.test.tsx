import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AdminUser } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AdminPage } from "./AdminPage";

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
  fetchAdminInstance: vi.fn().mockResolvedValue({ sentWithFooter: false }),
  updateAdminInstance: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchAdminUsers, createAdminUser, setUserRole, setUserActive, setUserCredential,
  fetchAdminSso, updateAdminSso, fetchAdminInstance, updateAdminInstance,
}));

const adminActive: AdminUser = {
  id: "u1",
  email: "admin@example.com",
  displayName: "Admin One",
  role: "admin",
  locale: "es",
  active: true,
  mailboxLinked: true,
};

const employeeUnlinked: AdminUser = {
  id: "u2",
  email: "emp@example.com",
  displayName: "Employee Two",
  role: "employee",
  locale: "es",
  active: true,
  mailboxLinked: false,
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
  fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.nav.users") }));
  return client;
}

describe("AdminPage users table", () => {
  it("lists users with mailbox/status text and a role select per row", async () => {
    fetchAdminUsers.mockResolvedValue([adminActive, employeeUnlinked]);
    renderPage();

    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("emp@example.com")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("admin.mailbox.linked"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("admin.mailbox.unlinked"))).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("combobox", { name: i18n.t("admin.actions.role") })).toHaveLength(2);
  });

  it("renders each row with an avatar showing the user's initials next to their name", async () => {
    fetchAdminUsers.mockResolvedValue([adminActive, employeeUnlinked]);
    renderPage();

    const row = (await screen.findByText("admin@example.com")).closest("tr") as HTMLElement;
    expect(within(row).getByText("AO")).toBeInTheDocument();
    expect(within(row).getByText("Admin One")).toBeInTheDocument();
  });

  // GH #130: the admin contract now carries the user's uploaded photo
  // (adminUserSchema.avatarDataUrl) — the row must render it instead of
  // initials, reusing Avatar's existing photo-or-initials decision.
  it("renders a user's uploaded photo instead of initials when avatarDataUrl is present", async () => {
    const withPhoto: AdminUser = { ...adminActive, avatarDataUrl: "data:image/png;base64,AAAA" };
    fetchAdminUsers.mockResolvedValue([withPhoto]);
    renderPage();

    const row = (await screen.findByText("admin@example.com")).closest("tr") as HTMLElement;
    const img = row.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(within(row).queryByText("AO")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no users", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(i18n.t("admin.empty"))).toBeInTheDocument();
  });

  it("shows a load-error banner when the users query fails", async () => {
    fetchAdminUsers.mockRejectedValue(new Error("boom"));
    renderPage();
    expect(await screen.findByText(i18n.t("admin.errors.load"))).toBeInTheDocument();
  });

  it("reveals a password input on 'link mailbox' and calls setUserCredential on save", async () => {
    fetchAdminUsers.mockResolvedValue([employeeUnlinked]);
    setUserCredential.mockResolvedValue(undefined);
    renderPage();

    const row = (await screen.findByText("emp@example.com")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: i18n.t("admin.actions.linkMailbox") }));

    const passwordInput = within(row).getByLabelText(i18n.t("admin.actions.linkMailbox"));
    fireEvent.change(passwordInput, { target: { value: "supersecret1" } });
    fireEvent.click(within(row).getByRole("button", { name: i18n.t("admin.actions.saveCredential") }));

    await waitFor(() => expect(setUserCredential).toHaveBeenCalledWith("u2", "supersecret1"));
  });

  it("changes the role via the select and calls setUserRole", async () => {
    fetchAdminUsers.mockResolvedValue([employeeUnlinked]);
    setUserRole.mockResolvedValue({ ...employeeUnlinked, role: "admin" });
    renderPage();

    const row = (await screen.findByText("emp@example.com")).closest("tr") as HTMLElement;
    fireEvent.change(within(row).getByRole("combobox", { name: i18n.t("admin.actions.role") }), {
      target: { value: "admin" },
    });

    await waitFor(() => expect(setUserRole).toHaveBeenCalledWith("u2", "admin"));
  });

  it("archives via a two-click inline confirm", async () => {
    fetchAdminUsers.mockResolvedValue([adminActive]);
    setUserActive.mockResolvedValue({ ...adminActive, active: false });
    renderPage();

    const row = (await screen.findByText("admin@example.com")).closest("tr") as HTMLElement;
    const archiveButton = within(row).getByRole("button", { name: i18n.t("admin.actions.archive") });
    fireEvent.click(archiveButton);

    expect(within(row).getByRole("button", { name: i18n.t("admin.actions.confirmArchive") })).toBeInTheDocument();
    expect(setUserActive).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole("button", { name: i18n.t("admin.actions.confirmArchive") }));
    await waitFor(() => expect(setUserActive).toHaveBeenCalledWith("u1", false));
  });

  it("reactivates with a single click (no confirm step)", async () => {
    const archived = { ...employeeUnlinked, active: false };
    fetchAdminUsers.mockResolvedValue([archived]);
    setUserActive.mockResolvedValue({ ...archived, active: true });
    renderPage();

    const row = (await screen.findByText("emp@example.com")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: i18n.t("admin.actions.reactivate") }));
    await waitFor(() => expect(setUserActive).toHaveBeenCalledWith("u2", true));
  });

  it("shows an inline action error when a mutation fails", async () => {
    fetchAdminUsers.mockResolvedValue([employeeUnlinked]);
    setUserRole.mockRejectedValue(new Error("boom"));
    renderPage();

    const row = (await screen.findByText("emp@example.com")).closest("tr") as HTMLElement;
    fireEvent.change(within(row).getByRole("combobox", { name: i18n.t("admin.actions.role") }), {
      target: { value: "admin" },
    });

    expect(await within(row).findByText(i18n.t("admin.errors.action"))).toBeInTheDocument();
  });

  it("submits the new-user form and calls createAdminUser", async () => {
    fetchAdminUsers.mockResolvedValue([]);
    createAdminUser.mockResolvedValue(adminActive);
    renderPage();

    await screen.findByText(i18n.t("admin.empty"));

    fireEvent.change(screen.getByLabelText(i18n.t("admin.new.email")), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(screen.getByLabelText(i18n.t("admin.new.name")), {
      target: { value: "New Person" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.new.create") }));

    await waitFor(() => expect(createAdminUser).toHaveBeenCalledTimes(1));
    expect(createAdminUser.mock.calls[0]?.[0]).toMatchObject({
      email: "new@example.com",
      displayName: "New Person",
      role: "employee",
    });
  });
});
