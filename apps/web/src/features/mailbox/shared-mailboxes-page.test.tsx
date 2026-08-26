import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { SharedAccount } from "@webmail/shared";
import { MailApiError } from "./api";
import { ToastProvider } from "../../app/ui/toast";
import { SharedMailboxesPage } from "./SharedMailboxesPage";

const { fetchSharedAccounts, setSharedAccountCopyPreference } = vi.hoisted(() => ({
  fetchSharedAccounts: vi.fn(),
  setSharedAccountCopyPreference: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchSharedAccounts, setSharedAccountCopyPreference };
});

const ventas: SharedAccount = { id: "acc-ventas", name: "Ventas", copyOptIn: false };
const soporte: SharedAccount = { id: "acc-soporte", name: "Soporte", copyOptIn: true };

function copyToggleName(name: string): string {
  return i18n.t("sharedMailboxes.copyToggle", { name });
}

// Exposes the live location so an "Entrar" navigation is observable without a
// real browser (mirrors the shared-mailbox banner test's location probe).
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/shared"]}>
          <SharedMailboxesPage />
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SharedMailboxesPage (GH #13/#50 G-4)", () => {
  it("renders the page heading and lists the shared mailboxes with the copy toggle reflecting copyOptIn", async () => {
    fetchSharedAccounts.mockResolvedValue([ventas, soporte]);
    renderPage();

    expect(
      await screen.findByRole("heading", { name: i18n.t("sharedMailboxes.title") }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Ventas")).toBeInTheDocument();
    expect(screen.getByText("Soporte")).toBeInTheDocument();

    expect(screen.getByLabelText(copyToggleName("Ventas"))).not.toBeChecked();
    expect(screen.getByLabelText(copyToggleName("Soporte"))).toBeChecked();
  });

  // GH #313: the helper used to promise automatic delivery "in an upcoming
  // update" and point at the manual copy. Delivery is automatic now, in both
  // languages, so the copy must not keep apologising for a gap that is closed.
  it("describes automatic delivery without deferring it to a later update", async () => {
    fetchSharedAccounts.mockResolvedValue([ventas]);
    renderPage();
    await screen.findByText("Ventas");

    for (const language of ["en", "es"]) {
      const help = i18n.getFixedT(language)("sharedMailboxes.copyHelp");
      expect(help).not.toMatch(/upcoming|manual|próxima actualización|manualmente/i);
      expect(help.length).toBeGreaterThan(0);
    }
    expect(screen.getByText(i18n.t("sharedMailboxes.copyHelp"))).toBeInTheDocument();
  });

  it("optimistically flips the toggle and PUTs the opt-in on click", async () => {
    fetchSharedAccounts.mockResolvedValue([ventas]);
    // A pending promise keeps the mutation in flight, so the checkbox we assert
    // on is showing the OPTIMISTIC state, not a server round-trip.
    setSharedAccountCopyPreference.mockReturnValue(new Promise<SharedAccount>(() => {}));
    renderPage();

    const toggle = await screen.findByLabelText(copyToggleName("Ventas"));
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByLabelText(copyToggleName("Ventas"))).toBeChecked());
    expect(setSharedAccountCopyPreference).toHaveBeenCalledWith("acc-ventas", true);
  });

  it("reverts the toggle and shows a toast when the PUT fails", async () => {
    fetchSharedAccounts.mockResolvedValue([ventas]);
    setSharedAccountCopyPreference.mockRejectedValue(new MailApiError(403, "account_forbidden"));
    renderPage();

    const toggle = await screen.findByLabelText(copyToggleName("Ventas"));
    fireEvent.click(toggle);

    expect(await screen.findByText(i18n.t("sharedMailboxes.copyError"))).toBeInTheDocument();
    expect(setSharedAccountCopyPreference).toHaveBeenCalledWith("acc-ventas", true);
    await waitFor(() => expect(screen.getByLabelText(copyToggleName("Ventas"))).not.toBeChecked());
  });

  it("'Entrar' switches to the mailbox by setting the account URL param", async () => {
    fetchSharedAccounts.mockResolvedValue([ventas]);
    renderPage();

    await screen.findByText("Ventas");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("sharedMailboxes.enter") }));

    expect(screen.getByTestId("location").textContent).toBe("/?account=acc-ventas");
  });

  it("renders a friendly empty state when there are no shared mailboxes", async () => {
    fetchSharedAccounts.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(i18n.t("sharedMailboxes.empty"))).toBeInTheDocument();
  });

  it("shows a retry instead of a blank page when the list cannot be loaded", async () => {
    fetchSharedAccounts.mockRejectedValueOnce(new MailApiError(503, "database_unavailable"));
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("settings.errors.generic"));

    fetchSharedAccounts.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.retry") }));

    expect(await screen.findByText(i18n.t("sharedMailboxes.empty"))).toBeInTheDocument();
  });
});
