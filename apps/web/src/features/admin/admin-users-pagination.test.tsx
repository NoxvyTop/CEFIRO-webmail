import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { AdminUser, AdminUsersPage } from "@webmail/shared";
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

// GH #153: pagination and search are server-side now, so the mock replays what
// the endpoint would do — slice/filter the full set by the params it's given.
type PageParams = { page: number; pageSize: number; search?: string };

function pageFor(all: AdminUser[], params: PageParams): AdminUsersPage {
  const term = params.search?.toLowerCase() ?? "";
  const filtered = term
    ? all.filter(
        (u) => u.email.toLowerCase().includes(term) || u.displayName.toLowerCase().includes(term),
      )
    : all;
  const start = (params.page - 1) * params.pageSize;
  return {
    users: filtered.slice(start, start + params.pageSize),
    total: filtered.length,
    stats: {
      total: all.length,
      active: all.filter((u) => u.active).length,
      mailboxLinked: all.filter((u) => u.mailboxLinked).length,
    },
  };
}

function serve(all: AdminUser[]) {
  fetchAdminUsers.mockImplementation((params: PageParams) => Promise.resolve(pageFor(all, params)));
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
  fireEvent.click(screen.getByRole("button", { name: i18n.t("admin.nav.users") }));
  return client;
}

describe("AdminPage users table server-driven pagination and search", () => {
  it("shows only the first 25 users and a range count when there are more than a page's worth", async () => {
    serve(makeUsers(30));
    renderPage();

    expect(await screen.findByText("user0@example.com")).toBeInTheDocument();
    expect(screen.getByText("user24@example.com")).toBeInTheDocument();
    expect(screen.queryByText("user25@example.com")).not.toBeInTheDocument();

    expect(
      screen.getByText(i18n.t("admin.pagination.range", { from: 1, to: 25, total: 30 })),
    ).toBeInTheDocument();
  });

  it("fetches the next page from the server and updates the range, disabling next at the last page", async () => {
    serve(makeUsers(30));
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

    // The second page was fetched from the server, not sliced in memory.
    expect(fetchAdminUsers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 25 }),
    );
  });

  it("filters via the search input (server-side) and resets to the first page", async () => {
    serve([
      ...makeUsers(30),
      {
        id: "special",
        email: "zzz@special.com",
        displayName: "Special Target",
        role: "employee" as const,
        locale: "es",
        active: true,
        mailboxLinked: true,
      },
    ]);
    renderPage();

    await screen.findByText("user0@example.com");
    const searchInput = screen.getByRole("searchbox", { name: i18n.t("admin.search.placeholder") });
    fireEvent.change(searchInput, { target: { value: "special" } });

    expect(await screen.findByText("zzz@special.com")).toBeInTheDocument();
    expect(screen.queryByText("user0@example.com")).not.toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("admin.pagination.range", { from: 1, to: 1, total: 1 })),
    ).toBeInTheDocument();
    // The search term reached the server (debounced), starting from page 1.
    expect(fetchAdminUsers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, search: "special" }),
    );
  });

  it("shows a no-results message and hides pagination when the search matches nothing", async () => {
    serve(makeUsers(5));
    renderPage();

    await screen.findByText("user0@example.com");
    const searchInput = screen.getByRole("searchbox", { name: i18n.t("admin.search.placeholder") });
    fireEvent.change(searchInput, { target: { value: "nonexistent" } });

    expect(await screen.findByText(i18n.t("admin.search.noResults"))).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: i18n.t("admin.pagination.next") })).not.toBeInTheDocument();
  });

  it("gives the table its own scrollable wrapper (not the whole section) so overflow is visible and intentional", async () => {
    serve(makeUsers(3));
    renderPage();

    const table = await screen.findByRole("table");
    const wrapper = table.parentElement as HTMLElement;
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.className).toContain("overflow-x-auto");
  });
});
