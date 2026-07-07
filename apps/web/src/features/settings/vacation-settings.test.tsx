import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { VacationSettings as VacationSettingsData } from "@webmail/shared";
import { VacationSettings } from "./VacationSettings";

const { fetchVacationSettings, updateVacationSettings } = vi.hoisted(() => ({
  fetchVacationSettings: vi.fn(),
  updateVacationSettings: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchVacationSettings, updateVacationSettings };
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
  it("renders the loaded settings", async () => {
    renderVacation();
    expect(await screen.findByLabelText(i18n.t("vacation.message"))).toHaveValue(
      "Back on the 20th",
    );
    expect(screen.getByLabelText(i18n.t("vacation.enabled"))).not.toBeChecked();
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
