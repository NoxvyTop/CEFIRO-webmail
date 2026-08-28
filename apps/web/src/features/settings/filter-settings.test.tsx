import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { FilterRule, Mailbox, SieveSyncState } from "@webmail/shared";
import { MailApiError } from "../mailbox/api";
import { FilterSettings } from "./FilterSettings";

const {
  fetchFilterRules,
  fetchFilterSyncState,
  createFilterRule,
  updateFilterRule,
  deleteFilterRule,
  reorderFilterRules,
  syncFilters,
  fetchSieveCapability,
  fetchSieveRawScript,
} = vi.hoisted(() => ({
  fetchFilterRules: vi.fn(),
  fetchFilterSyncState: vi.fn(),
  fetchSieveCapability: vi.fn(),
  fetchSieveRawScript: vi.fn(),
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
    fetchFilterSyncState,
    createFilterRule,
    updateFilterRule,
    deleteFilterRule,
    reorderFilterRules,
    syncFilters,
    fetchSieveCapability,
    fetchSieveRawScript,
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

const SYNCED: SieveSyncState = {
  status: "synced",
  attempts: 0,
  lastError: null,
  updatedAt: "2026-07-01T10:00:00.000Z",
};

function syncState(overrides: Partial<SieveSyncState> = {}): SieveSyncState {
  return { ...SYNCED, ...overrides };
}

function renderFilters(rules: FilterRule[] = [ruleA, ruleB], sync: SieveSyncState = SYNCED) {
  fetchFilterRules.mockResolvedValue(rules);
  fetchFilterSyncState.mockResolvedValue(sync);
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
    // The Stalwart case, and the one every test below assumes unless it says
    // otherwise: the mail server can run Sieve (GH #36).
    fetchSieveCapability.mockResolvedValue({ supported: true });
    // And the rule builder still owns the script (GH #23) — the mode every
    // account starts in, and the one the tests below assume unless they say so.
    fetchSieveRawScript.mockResolvedValue({ mode: "rules", script: "", updatedAt: null });
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
    // #348: deleting a rule is irreversible — the first click only asks for
    // confirmation (two-step confirm, matching Sidebar's label delete).
    fireEvent.click(deleteButtons[0]!);
    expect(deleteFilterRule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("filters.confirmDeleteAction") }));

    await waitFor(() => expect(deleteFilterRule).toHaveBeenCalledWith("a"));
  });

  it("cancels the delete confirmation without deleting a rule", async () => {
    renderFilters();

    await screen.findByText("invoices");
    fireEvent.click(screen.getAllByRole("button", { name: i18n.t("settings.delete") })[0]!);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("filters.cancelDelete") }));

    expect(deleteFilterRule).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: i18n.t("settings.delete") })).toHaveLength(2);
  });

  it("shows the sync-failed banner with a working retry button", async () => {
    deleteFilterRule.mockRejectedValueOnce(new MailApiError(502, "sieve_sync_failed"));
    syncFilters.mockResolvedValueOnce({ status: "ok" });
    renderFilters();

    await screen.findByText("invoices");
    fireEvent.click(screen.getAllByRole("button", { name: i18n.t("settings.delete") })[0]!);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("filters.confirmDeleteAction") }));

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

  // GH #250: the empty state was gated on `isLoading` alone, so a rules list
  // that could not be fetched rendered as "no rules yet" — the UI telling the
  // user their filters are gone when it simply has no idea.
  describe("failed load (GH #250)", () => {
    function renderFailing() {
      fetchMailboxes.mockResolvedValue(mailboxes);
      fetchFilterSyncState.mockResolvedValue(SYNCED);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <FilterSettings />
        </QueryClientProvider>,
      );
    }

    it("never claims there are no rules when the load failed", async () => {
      fetchFilterRules.mockRejectedValue(new MailApiError(503, "database_unavailable"));
      renderFailing();

      expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settings.errors.generic"));
      expect(screen.queryByText(i18n.t("filters.empty"))).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: i18n.t("filters.newRule") })).not.toBeInTheDocument();
    });

    it("recovers through the retry button without a page reload", async () => {
      fetchFilterRules.mockRejectedValueOnce(new MailApiError(503, "database_unavailable"));
      renderFailing();

      await screen.findByRole("alert");
      fetchFilterRules.mockResolvedValue([ruleA]);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.retry") }));

      expect(await screen.findByText("invoices")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("shows the loading state, not the empty state, before the first response", async () => {
      fetchFilterRules.mockReturnValue(new Promise(() => {}));
      renderFailing();

      expect(await screen.findByTestId("settings-loading")).toBeInTheDocument();
      expect(screen.queryByText(i18n.t("filters.empty"))).not.toBeInTheDocument();
    });
  });

  // GH #254: #221 recorded on the server whether Stalwart is actually running
  // the rules this page lists, and nothing here read it. A push that failed
  // before the page was reloaded left the rules looking active, because the
  // only warning was tied to the mutation that failed in that same session.
  describe("sieve sync state (GH #254)", () => {
    it("says nothing when the server reports the rules are synced", async () => {
      renderFilters([ruleA], syncState({ status: "synced" }));

      await screen.findByText("invoices");
      expect(screen.queryByTestId("sieve-sync-warning")).not.toBeInTheDocument();
    });

    it("warns that a pending rule is saved but not applied, and offers a retry", async () => {
      renderFilters([ruleA], syncState({ status: "pending", lastError: null }));

      const warning = await screen.findByTestId("sieve-sync-warning");
      expect(warning).toHaveTextContent(i18n.t("filters.sync.pending"));
      // The rule is still listed as enabled, so the banner is the only thing
      // telling the user it is not filtering anything.
      expect(screen.getByRole("button", { name: i18n.t("filters.enabled") })).toBeInTheDocument();
      expect(
        within(warning).getByRole("button", { name: i18n.t("filters.reapply") }),
      ).toBeInTheDocument();
    });

    it("warns on a retryable failure and offers a retry", async () => {
      renderFilters([ruleA], syncState({ status: "failed", lastError: "stalwart_unavailable" }));

      const warning = await screen.findByTestId("sieve-sync-warning");
      expect(warning).toHaveTextContent(i18n.t("filters.sync.failed"));
      expect(
        within(warning).getByRole("button", { name: i18n.t("filters.reapply") }),
      ).toBeInTheDocument();
    });

    it("says a sieve_invalid failure will not fix itself, and offers no retry", async () => {
      renderFilters([ruleA], syncState({ status: "failed", lastError: "sieve_invalid" }));

      const warning = await screen.findByTestId("sieve-sync-warning");
      expect(warning).toHaveTextContent(i18n.t("filters.sync.invalid"));
      // Retrying pushes the same rejected script again — a button that cannot
      // work is worse than no button.
      expect(
        within(warning).queryByRole("button", { name: i18n.t("filters.reapply") }),
      ).not.toBeInTheDocument();
    });

    it("offers the retry on a state read at load time, with no error in this session", async () => {
      syncFilters.mockResolvedValueOnce({ status: "ok" });
      renderFilters([ruleA], syncState({ status: "failed", lastError: "stalwart_unavailable" }));

      const warning = await screen.findByTestId("sieve-sync-warning");
      // Nothing failed in this session — the old UI showed no retry at all here.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      fetchFilterSyncState.mockResolvedValue(SYNCED);
      fireEvent.click(within(warning).getByRole("button", { name: i18n.t("filters.reapply") }));

      await waitFor(() => expect(syncFilters).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(i18n.t("filters.reapplied"))).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByTestId("sieve-sync-warning")).not.toBeInTheDocument(),
      );
    });

    it("stays quiet when the sync state itself cannot be read", async () => {
      fetchFilterRules.mockResolvedValue([ruleA]);
      fetchMailboxes.mockResolvedValue(mailboxes);
      fetchFilterSyncState.mockRejectedValue(new MailApiError(500, "internal"));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <FilterSettings />
        </QueryClientProvider>,
      );

      await screen.findByText("invoices");
      // An unreadable advisory is not evidence of a problem; inventing a
      // warning out of it would be its own lie.
      expect(screen.queryByTestId("sieve-sync-warning")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  // GH #36: filters are a Sieve script pushed over a JMAP extension the
  // provider is free not to implement. Against one that does not, the editor
  // was fully offered and every single save came back as a JMAP failure.
  describe("mail server without Sieve (GH #36)", () => {
    it("says filters are unavailable instead of offering an editor that cannot save", async () => {
      fetchSieveCapability.mockResolvedValue({ supported: false });
      renderFilters();

      expect(await screen.findByTestId("settings-unavailable")).toHaveTextContent(
        i18n.t("filters.unavailable"),
      );
      expect(screen.queryByRole("button", { name: i18n.t("filters.newRule") })).not.toBeInTheDocument();
      // Not an error state: nothing went wrong and nothing can be retried.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("leaves the editor alone when the capability read itself fails", async () => {
      // An unreadable capability says nothing about the server. Withdrawing the
      // feature on it would take a working editor away over a failed request.
      fetchSieveCapability.mockRejectedValue(new MailApiError(503, "database_unavailable"));
      renderFilters();

      expect(await screen.findByText("invoices")).toBeInTheDocument();
      expect(screen.queryByTestId("settings-unavailable")).not.toBeInTheDocument();
    });

    it("keeps the editor while the capability is still unknown", async () => {
      fetchSieveCapability.mockReturnValue(new Promise(() => {}));
      renderFilters();

      // No flash of "unavailable" on the way to a server that supports it.
      expect(await screen.findByText("invoices")).toBeInTheDocument();
      expect(screen.queryByTestId("settings-unavailable")).not.toBeInTheDocument();
    });
  });

  // GH #23: the rules stay listed, enabled and editable while a hand-written
  // script owns the account — so nothing in this list says they are not being
  // applied. The banner is the only thing that does.
  describe("advanced mode is on (GH #23)", () => {
    it("says the listed rules are not being applied", async () => {
      fetchSieveRawScript.mockResolvedValue({
        mode: "raw",
        script: "stop;\n",
        updatedAt: "2026-07-01T10:00:00.000Z",
      });
      renderFilters([ruleA]);

      expect(await screen.findByTestId("sieve-advanced-notice")).toHaveTextContent(
        i18n.t("filters.advanced.notice"),
      );
      // Still listed and still editable: they are what comes back when the
      // script is handed over again, so withdrawing the editor would be worse.
      expect(screen.getByText("invoices")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: i18n.t("filters.newRule") })).toBeInTheDocument();
    });

    it("says nothing while the rule builder still owns the script", async () => {
      renderFilters([ruleA]);

      await screen.findByText("invoices");
      expect(screen.queryByTestId("sieve-advanced-notice")).not.toBeInTheDocument();
    });

    it("stays quiet when the advanced state itself cannot be read", async () => {
      fetchSieveRawScript.mockRejectedValue(new MailApiError(500, "internal"));
      renderFilters([ruleA]);

      await screen.findByText("invoices");
      expect(screen.queryByTestId("sieve-advanced-notice")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("is not offered at all on a mail server without Sieve", async () => {
      // GH #36: the editor lives inside the panel the capability gate replaces,
      // so a provider that cannot run Sieve is never offered one to write.
      fetchSieveCapability.mockResolvedValue({ supported: false });
      renderFilters();

      await screen.findByTestId("settings-unavailable");
      expect(
        screen.queryByRole("button", { name: i18n.t("filters.advanced.title") }),
      ).not.toBeInTheDocument();
    });
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
