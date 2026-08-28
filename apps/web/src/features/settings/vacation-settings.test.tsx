import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { VacationSettings as VacationSettingsData } from "@webmail/shared";
import { VacationSettings } from "./VacationSettings";

const {
  fetchVacationSettings,
  updateVacationSettings,
  fetchSieveCapability,
  fetchSieveRawScript,
} = vi.hoisted(() => ({
  fetchVacationSettings: vi.fn(),
  updateVacationSettings: vi.fn(),
  fetchSieveCapability: vi.fn(),
  fetchSieveRawScript: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchVacationSettings,
    updateVacationSettings,
    fetchSieveCapability,
    fetchSieveRawScript,
  };
});

const settings: VacationSettingsData = {
  enabled: false,
  subject: "",
  message: "Back on the 20th",
  startsAt: null,
  endsAt: null,
  intervalDays: 7,
};

function renderVacation(data: VacationSettingsData = settings) {
  fetchVacationSettings.mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <VacationSettings />
    </QueryClientProvider>,
  );
}

describe("VacationSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The Stalwart case, assumed by every test that does not say otherwise:
    // the mail server can run the Sieve `vacation` action (GH #36).
    fetchSieveCapability.mockResolvedValue({ supported: true });
    // And the rule builder still owns the script (GH #23), so what this form
    // saves is also what runs.
    fetchSieveRawScript.mockResolvedValue({ mode: "rules", script: "", updatedAt: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
  it("renders the loaded settings", async () => {
    renderVacation();
    expect(await screen.findByLabelText(i18n.t("vacation.message"))).toHaveValue(
      "Back on the 20th",
    );
    const enabledCheckbox = screen.getByLabelText(i18n.t("vacation.enabled"));
    expect(enabledCheckbox).not.toBeChecked();
    // #348: DevTools warns "A form field element should have an id or name
    // attribute" — this checkbox had neither.
    expect(enabledCheckbox).toHaveAttribute("name", "vacation-enabled");
  });

  it("saves the edited settings", async () => {
    updateVacationSettings.mockResolvedValueOnce({ ...settings, enabled: true });
    renderVacation();

    const enabledBox = await screen.findByLabelText(i18n.t("vacation.enabled"));
    fireEvent.click(enabledBox);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("vacation.save") }));

    await waitFor(() => expect(updateVacationSettings).toHaveBeenCalledTimes(1));
    expect(updateVacationSettings.mock.calls[0]?.[0]).toMatchObject({
      enabled: true,
      message: "Back on the 20th",
    });
    expect(await screen.findByText(i18n.t("vacation.saved"))).toBeInTheDocument();
  });

  it("blocks enabling with a blank message and shows the inline error", async () => {
    renderVacation({ ...settings, message: "" });

    const enabledBox = await screen.findByLabelText(i18n.t("vacation.enabled"));
    fireEvent.click(enabledBox);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("vacation.save") }));

    expect(
      await screen.findByText(i18n.t("settings.errors.vacationMessageRequired")),
    ).toBeInTheDocument();
    expect(updateVacationSettings).not.toHaveBeenCalled();
  });

  it("blocks saving when the end date is before the start date", async () => {
    renderVacation({ ...settings, startsAt: "2026-07-20", endsAt: "2026-07-10" });

    await screen.findByLabelText(i18n.t("vacation.enabled"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("vacation.save") }));

    expect(
      await screen.findByText(i18n.t("settings.errors.vacationDateOrder")),
    ).toBeInTheDocument();
    expect(updateVacationSettings).not.toHaveBeenCalled();
  });

  // GH #272: a failed load used to `return null` — a blank panel that admits
  // nothing and offers no way back. It now shows #250's load-error language with
  // a retry that recovers into the form.
  it("shows a retry instead of a blank panel when the settings cannot be loaded", async () => {
    const { MailApiError } = await import("../mailbox/api");
    fetchVacationSettings.mockRejectedValueOnce(new MailApiError(503, "database_unavailable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <VacationSettings />
      </QueryClientProvider>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("settings.errors.generic"));
    expect(screen.queryByLabelText(i18n.t("vacation.message"))).not.toBeInTheDocument();

    fetchVacationSettings.mockResolvedValue(settings);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.retry") }));

    expect(await screen.findByLabelText(i18n.t("vacation.message"))).toBeInTheDocument();
  });

  it("shows the sync-failed error from the server", async () => {
    const { MailApiError } = await import("../mailbox/api");
    updateVacationSettings.mockRejectedValueOnce(new MailApiError(502, "sieve_sync_failed"));
    renderVacation();

    await screen.findByLabelText(i18n.t("vacation.enabled"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("vacation.save") }));

    expect(
      await screen.findByText(i18n.t("settings.errors.sieve_sync_failed")),
    ).toBeInTheDocument();
  });
});

// GH #36: an automatic reply is a Sieve `vacation` action, so a provider
// without the extension can never send one — however carefully the form is
// filled in and however successfully the settings are stored here.
describe("VacationSettings without Sieve (GH #36)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says automatic replies are unavailable instead of offering the form", async () => {
    fetchSieveCapability.mockResolvedValue({ supported: false });
    renderVacation();

    expect(await screen.findByTestId("settings-unavailable")).toHaveTextContent(
      i18n.t("vacation.unavailable"),
    );
    expect(screen.queryByLabelText(i18n.t("vacation.message"))).not.toBeInTheDocument();
  });

  it("keeps the form when the capability is unknown or unreadable", async () => {
    fetchSieveCapability.mockRejectedValue(new Error("offline"));
    renderVacation();

    expect(await screen.findByLabelText(i18n.t("vacation.message"))).toBeInTheDocument();
    expect(screen.queryByTestId("settings-unavailable")).not.toBeInTheDocument();
  });
});

// GH #23: an automatic reply is part of the same Sieve script the advanced
// editor takes over. While a hand-written script owns the account, this form
// still saves — and what it saves is not what runs.
describe("VacationSettings while a hand-written script runs (GH #23)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSieveCapability.mockResolvedValue({ supported: true });
  });

  it("says the reply is saved but not being sent", async () => {
    fetchSieveRawScript.mockResolvedValue({
      mode: "raw",
      script: "stop;\n",
      updatedAt: "2026-07-01T10:00:00.000Z",
    });
    renderVacation();

    expect(await screen.findByTestId("sieve-advanced-notice")).toHaveTextContent(
      i18n.t("vacation.advancedNotice"),
    );
    // The form is left alone: it is where the user prepares the reply that
    // comes back the moment they hand the script over to their rules again.
    expect(screen.getByLabelText(i18n.t("vacation.message"))).toBeInTheDocument();
  });

  it("says nothing while the rule builder still owns the script", async () => {
    fetchSieveRawScript.mockResolvedValue({ mode: "rules", script: "", updatedAt: null });
    renderVacation();

    await screen.findByLabelText(i18n.t("vacation.message"));
    expect(screen.queryByTestId("sieve-advanced-notice")).not.toBeInTheDocument();
  });
});
