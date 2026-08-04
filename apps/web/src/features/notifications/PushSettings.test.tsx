import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { PushSettings } from "./PushSettings";

const { fetchPushStatus, enablePush, disablePush, getExistingPushSubscription, isPushSupported } =
  vi.hoisted(() => ({
    fetchPushStatus: vi.fn(),
    enablePush: vi.fn(),
    disablePush: vi.fn(),
    getExistingPushSubscription: vi.fn(),
    isPushSupported: vi.fn(),
  }));

vi.mock("./pushApi", () => ({ fetchPushStatus }));
vi.mock("./push", () => ({ enablePush, disablePush, getExistingPushSubscription, isPushSupported }));

beforeEach(() => {
  vi.clearAllMocks();
  isPushSupported.mockReturnValue(true);
  getExistingPushSubscription.mockResolvedValue(null);
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PushSettings />
    </QueryClientProvider>,
  );
}

describe("PushSettings", () => {
  it("renders nothing when push is disabled on the server", async () => {
    fetchPushStatus.mockResolvedValue(false);
    renderPanel();

    await waitFor(() => expect(fetchPushStatus).toHaveBeenCalled());
    expect(screen.queryByText(i18n.t("notifications.description"))).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: i18n.t("notifications.enable") }),
    ).not.toBeInTheDocument();
  });

  it("shows the enable opt-in when push is enabled and this device is not subscribed", async () => {
    fetchPushStatus.mockResolvedValue(true);
    getExistingPushSubscription.mockResolvedValue(null);
    renderPanel();

    expect(
      await screen.findByRole("button", { name: i18n.t("notifications.enable") }),
    ).toBeInTheDocument();
    expect(screen.getByText(i18n.t("notifications.description"))).toBeInTheDocument();
  });

  it("subscribes on click and then shows the enabled state with a disable button", async () => {
    fetchPushStatus.mockResolvedValue(true);
    getExistingPushSubscription.mockResolvedValue(null);
    enablePush.mockResolvedValue("subscribed");
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("notifications.enable") }));

    await waitFor(() => expect(enablePush).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(i18n.t("notifications.enabledOnThisDevice"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("notifications.disable") }),
    ).toBeInTheDocument();
  });

  it("shows the disable button first when this device is already subscribed, and unsubscribes on click", async () => {
    fetchPushStatus.mockResolvedValue(true);
    getExistingPushSubscription.mockResolvedValue({ endpoint: "https://push/abc" });
    disablePush.mockResolvedValue(undefined);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("notifications.disable") }));

    await waitFor(() => expect(disablePush).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("button", { name: i18n.t("notifications.enable") }),
    ).toBeInTheDocument();
  });

  it("surfaces a denied permission as an alert without flipping to the enabled state", async () => {
    fetchPushStatus.mockResolvedValue(true);
    getExistingPushSubscription.mockResolvedValue(null);
    enablePush.mockResolvedValue("denied");
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("notifications.enable") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      i18n.t("notifications.errors.permissionDenied"),
    );
    expect(
      screen.queryByText(i18n.t("notifications.enabledOnThisDevice")),
    ).not.toBeInTheDocument();
  });

  it("shows an unsupported note when push is enabled but the browser cannot do it", async () => {
    fetchPushStatus.mockResolvedValue(true);
    isPushSupported.mockReturnValue(false);
    renderPanel();

    expect(await screen.findByText(i18n.t("notifications.unsupported"))).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: i18n.t("notifications.enable") }),
    ).not.toBeInTheDocument();
  });
});
