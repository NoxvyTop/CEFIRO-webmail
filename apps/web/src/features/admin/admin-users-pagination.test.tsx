import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AdminUser } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { AdminPage } from "./AdminPage";

const {
  fetchAdminUsers, createAdminUser, setUserRole, setUserActive, setUserCredential,
  fetchAdminSso, updateAdminSso,
} = vi.hoisted(() => ({
  fetchAdminUsers: vi.fn(),
  createAdminUser: vi.fn(),
  setUserRole: vi.fn(),
  setUserActive: vi.fn(),
  setUserCredential: vi.fn(),
  fetchAdminSso: vi.fn(),
  updateAdminSso: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchAdminUsers, createAdminUser, setUserRole, setUserActive, setUserCredential,
  fetchAdminSso, updateAdminSso,
}));

function makeUsers(count: number): AdminUser[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `u${index}`,
    email: `user${index}@example.com`,
    displayName: `User ${index}`,
    role: "employee" as const,
    locale: "es",
    active: true,
    mailboxLinked: true,
  }));
}

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

describe("AdminPage users table pagination and search", () => {
  it("shows only the first 25 users and a range count when there are more than a page's worth", async () => {
    fetchAdminUsers.mockResolvedValue(makeUsers(30));
    renderPage();

    expect(await screen.findByText("user0@example.com")).toBeInTheDocument();
    expect(screen.getByText("user24@example.com")).toBeInTheDocument();
    expect(screen.queryByText("user25@example.com")).not.toBeInTheDocument();

    expect(
      screen.getByText(i18n.t("admin.pagination.range", { from: 1, to: 25, total: 30 })),
    ).toBeInTheDocument();
  });

  it("moves to the next page and updates the range, disabling next at the last page", async () => {
    fetchAdminUsers.mockResolvedValue(makeUsers(30));
    renderPage();

    await screen.findByText("user0@example.com");
    const nextButton = screen.getByRole("button", { name: i18n.t("admin.pagination.next") });
    const prevButton = screen.getByRole("button", { name: i18n.t("admin.pagination.prev") });
    expect(prevButton).toBeDisabled();

    fireEvent.click(nextButton);

    expect(await screen.findByText("user25@example.com")).toBeInTheDocument();
    expect(screen.queryByText("user0@example.com")).not.toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("admin.pagination.range", { from: 26, to: 30, total: 30 })),
    ).toBeInTheDocument();
    expect(nextButton).toBeDisabled();
    expect(prevButton).not.toBeDisabled();
  });

  it("filters users by email or name via the search input and resets to the first page", async () => {
    const users = [...makeUsers(30), {
      id: "special",
      email: "zzz@special.com",
      displayName: "Special Target",
      role: "employee" as const,
      locale: "es",
      active: true,
      mailboxLinked: true,
    }];
    fetchAdminUsers.mockResolvedValue(users);
    renderPage();

    await screen.findByText("user0@example.com");
    const searchInput = screen.getByRole("searchbox", { name: i18n.t("admin.search.placeholder") });
    fireEvent.change(searchInput, { target: { value: "special" } });

    expect(await screen.findByText("zzz@special.com")).toBeInTheDocument();
    expect(screen.queryByText("user0@example.com")).not.toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("admin.pagination.range", { from: 1, to: 1, total: 1 })),
    ).toBeInTheDocument();
  });

  it("shows a no-results message and hides pagination when the search matches nothing", async () => {
    fetchAdminUsers.mockResolvedValue(makeUsers(5));
    renderPage();

    await screen.findByText("user0@example.com");
    const searchInput = screen.getByRole("searchbox", { name: i18n.t("admin.search.placeholder") });
    fireEvent.change(searchInput, { target: { value: "nonexistent" } });

    expect(await screen.findByText(i18n.t("admin.search.noResults"))).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: i18n.t("admin.pagination.next") })).not.toBeInTheDocument();
  });

  it("gives the table its own scrollable wrapper (not the whole section) so overflow is visible and intentional", async () => {
    fetchAdminUsers.mockResolvedValue(makeUsers(3));
    renderPage();

    const table = await screen.findByRole("table");
    const wrapper = table.parentElement as HTMLElement;
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.className).toContain("overflow-x-auto");
  });
});
