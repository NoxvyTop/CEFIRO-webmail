import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { FilterRule, Mailbox } from "@webmail/shared";
import { MailApiError } from "../mailbox/api";
import { FilterSettings } from "./FilterSettings";

const {
  fetchFilterRules,
  createFilterRule,
  updateFilterRule,
  deleteFilterRule,
  reorderFilterRules,
  syncFilters,
} = vi.hoisted(() => ({
  fetchFilterRules: vi.fn(),
  createFilterRule: vi.fn(),
  updateFilterRule: vi.fn(),
  deleteFilterRule: vi.fn(),
  reorderFilterRules: vi.fn(),
  syncFilters: vi.fn(),
}));

const { fetchMailboxes } = vi.hoisted(() => ({ fetchMailboxes: vi.fn() }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchFilterRules,
    createFilterRule,
    updateFilterRule,
    deleteFilterRule,
    reorderFilterRules,
    syncFilters,
  };
});

vi.mock("../mailbox/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mailbox/api")>();
  return { ...actual, fetchMailboxes };
});

const mailboxes: Mailbox[] = [
  { id: "m1", name: "Inbox", parentId: null, role: "inbox", sortOrder: 0, unreadEmails: 0, totalEmails: 0 },
];

const ruleA: FilterRule = {
  id: "a",
  position: 0,
  name: "invoices",
  matchType: "all",
  conditions: [{ field: "from", op: "contains", value: "billing@" }],
  actions: [{ type: "seen" }],
  enabled: true,
};

const ruleB: FilterRule = { ...ruleA, id: "b", position: 1, name: "newsletters" };

function renderFilters(rules: FilterRule[] = [ruleA, ruleB]) {
  fetchFilterRules.mockResolvedValue(rules);
  fetchMailboxes.mockResolvedValue(mailboxes);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FilterSettings />
    </QueryClientProvider>,
  );
}

describe("FilterSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists rules in order with their state toggles", async () => {
    renderFilters([ruleA, { ...ruleB, enabled: false }]);
    expect(await screen.findByText("invoices")).toBeInTheDocument();
    expect(screen.getByText("newsletters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("filters.enabled") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("filters.disabled") })).toBeInTheDocument();
  });

  it("shows the empty state without rules", async () => {
    renderFilters([]);
    expect(await screen.findByText(i18n.t("filters.empty"))).toBeInTheDocument();
  });

  it("creates a rule through the form", async () => {
    createFilterRule.mockResolvedValueOnce({ ...ruleA, id: "c", name: "clients" });
    renderFilters();

    await screen.findByText("invoices");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("filters.newRule") }));

    fireEvent.change(screen.getByLabelText(i18n.t("filters.name")), {
      target: { value: "clients" },
    });
    // per-row aria-labels are suffixed with the 1-based row number (a11y fix)
    fireEvent.change(screen.getByLabelText(`${i18n.t("filters.value")} 1`), {
      target: { value: "@client.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

    await waitFor(() => expect(createFilterRule).toHaveBeenCalledTimes(1));
    expect(createFilterRule.mock.calls[0]?.[0]).toMatchObject({ name: "clients" });
  });

  it("swaps neighbors and sends the full id list on move down", async () => {
    reorderFilterRules.mockResolvedValueOnce(undefined);
    renderFilters();

    await screen.findByText("invoices");
    const moveDownButtons = screen.getAllByRole("button", { name: i18n.t("filters.moveDown") });
    fireEvent.click(moveDownButtons[0]!);

    await waitFor(() => expect(reorderFilterRules).toHaveBeenCalledWith(["b", "a"]));
  });

  it("toggles a rule's enabled flag", async () => {
    updateFilterRule.mockResolvedValueOnce({ ...ruleA, enabled: false });
    renderFilters();

    await screen.findByText("invoices");
    // the toggle button shows the CURRENT state; both rules are enabled here
    const toggles = screen.getAllByRole("button", { name: i18n.t("filters.enabled") });
    fireEvent.click(toggles[0]!);

    await waitFor(() => expect(updateFilterRule).toHaveBeenCalledTimes(1));
    expect(updateFilterRule.mock.calls[0]?.[0]).toBe("a");
    expect(updateFilterRule.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
  });

  it("deletes a rule", async () => {
    deleteFilterRule.mockResolvedValueOnce(undefined);
    renderFilters();

    await screen.findByText("invoices");
    const deleteButtons = screen.getAllByRole("button", { name: i18n.t("settings.delete") });
    fireEvent.click(deleteButtons[0]!);

    await waitFor(() => expect(deleteFilterRule).toHaveBeenCalledWith("a"));
  });

  it("shows the sync-failed banner with a working retry button", async () => {
    deleteFilterRule.mockRejectedValueOnce(new MailApiError(502, "sieve_sync_failed"));
    syncFilters.mockResolvedValueOnce({ status: "ok" });
    renderFilters();

    await screen.findByText("invoices");
    fireEvent.click(screen.getAllByRole("button", { name: i18n.t("settings.delete") })[0]!);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(i18n.t("settings.errors.sieve_sync_failed"));

    fireEvent.click(screen.getByRole("button", { name: i18n.t("filters.reapply") }));
    await waitFor(() => expect(syncFilters).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(i18n.t("filters.reapplied"))).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes the form when a sieve sync error occurs on create", async () => {
    createFilterRule.mockRejectedValueOnce(new MailApiError(502, "sieve_sync_failed"));
    renderFilters();

    await screen.findByText("invoices");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("filters.newRule") }));
    fireEvent.change(screen.getByLabelText(i18n.t("filters.name")), {
      target: { value: "pending" },
    });
    fireEvent.change(screen.getByLabelText(`${i18n.t("filters.value")} 1`), {
      target: { value: "x@y" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(i18n.t("settings.errors.sieve_sync_failed"));
    expect(screen.queryByLabelText(i18n.t("filters.name"))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("filters.newRule") })).toBeInTheDocument();
  });

  it("keeps the form open on a non-sieve error", async () => {
    createFilterRule.mockRejectedValueOnce(new MailApiError(400, "invalid_body"));
    renderFilters();

    await screen.findByText("invoices");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("filters.newRule") }));
    fireEvent.change(screen.getByLabelText(i18n.t("filters.name")), {
      target: { value: "bad" },
    });
    fireEvent.change(screen.getByLabelText(`${i18n.t("filters.value")} 1`), {
      target: { value: "x@y" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(i18n.t("settings.errors.invalid_body"));
    expect(screen.getByLabelText(i18n.t("filters.name"))).toBeInTheDocument();
  });
});
