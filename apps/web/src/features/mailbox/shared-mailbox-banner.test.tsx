import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { SharedAccount } from "@webmail/shared";
import { SharedMailboxBanner } from "./SharedMailboxBanner";

const { fetchSharedAccounts } = vi.hoisted(() => ({ fetchSharedAccounts: vi.fn() }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchSharedAccounts };
});

const ventas: SharedAccount = { id: "acc-ventas", name: "Ventas", copyOptIn: false };

function renderBanner(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <SharedMailboxBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const indicatorText = i18n.t("sharedMailboxes.activeIndicator", { name: "Ventas" });
const backToPersonal = i18n.t("sharedMailboxes.backToPersonal");

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SharedMailboxBanner (GH #13/#50 G-4)", () => {
  it("shows nothing on the personal mailbox (no account param) and never fetches", () => {
    fetchSharedAccounts.mockResolvedValue([ventas]);
    renderBanner("/");

    expect(screen.queryByText(indicatorText)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: backToPersonal })).not.toBeInTheDocument();
    // The list is only reached when a shared mailbox is actually active.
    expect(fetchSharedAccounts).not.toHaveBeenCalled();
  });

  it("names the active shared mailbox and offers a way back to the personal inbox", async () => {
    fetchSharedAccounts.mockResolvedValue([ventas]);
    renderBanner("/?account=acc-ventas");

    expect(await screen.findByText(indicatorText)).toBeInTheDocument();
    const back = screen.getByRole("link", { name: backToPersonal });
    // "Volver" drops every param — it goes to the personal inbox at "/".
    expect(back).toHaveAttribute("href", "/");
  });

  it("shows nothing when the active account param names a mailbox it cannot resolve", async () => {
    fetchSharedAccounts.mockResolvedValue([ventas]);
    renderBanner("/?account=acc-unknown");

    // Let the query settle so this asserts on the resolved (empty match) state,
    // not merely on the pre-fetch render.
    await vi.waitFor(() => expect(fetchSharedAccounts).toHaveBeenCalled());
    expect(screen.queryByText(indicatorText)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: backToPersonal })).not.toBeInTheDocument();
  });
});
