import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { PushSettings } from "./PushSettings";

const { fetchPushStatus, enablePush, disablePush, resyncPushSubscription, isPushSupported } =
  vi.hoisted(() => ({
    fetchPushStatus: vi.fn(),
    enablePush: vi.fn(),
    disablePush: vi.fn(),
    resyncPushSubscription: vi.fn(),
    isPushSupported: vi.fn(),
  }));

vi.mock("./pushApi", () => ({ fetchPushStatus }));
vi.mock("./push", () => ({ enablePush, disablePush, resyncPushSubscription, isPushSupported }));

beforeEach(() => {
  vi.clearAllMocks();
  isPushSupported.mockReturnValue(true);
  resyncPushSubscription.mockResolvedValue(false);
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
  // GH #337: the panel used to render null when the server had no VAPID keys,
  // and the Settings nav hid the section with it — so "Notificaciones" simply
  // did not exist, with nothing to tell the user why.
  it("explains that background push is unavailable on this server instead of vanishing", async () => {
    fetchPushStatus.mockResolvedValue(false);
    renderPanel();

    expect(
      await screen.findByText(i18n.t("notifications.unavailableOnServer")),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: i18n.t("notifications.enable") }),
    ).not.toBeInTheDocument();
  });

  it("shows the enable opt-in when push is enabled and this device is not subscribed", async () => {
    fetchPushStatus.mockResolvedValue(true);
    resyncPushSubscription.mockResolvedValue(false);
    renderPanel();

    expect(
      await screen.findByRole("button", { name: i18n.t("notifications.enable") }),
    ).toBeInTheDocument();
    expect(screen.getByText(i18n.t("notifications.description"))).toBeInTheDocument();
  });

  it("subscribes on click and then shows the enabled state with a disable button", async () => {
    fetchPushStatus.mockResolvedValue(true);
    resyncPushSubscription.mockResolvedValue(false);
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
    resyncPushSubscription.mockResolvedValue(true);
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
    resyncPushSubscription.mockResolvedValue(false);
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

  // GH #337 (d): the browser holding a PushSubscription is not proof the server
  // still has the row, so the panel re-announces it on every load.
  it("re-posts this device's subscription to the server on load", async () => {
    fetchPushStatus.mockResolvedValue(true);
    resyncPushSubscription.mockResolvedValue(true);
    renderPanel();

    await waitFor(() => expect(resyncPushSubscription).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(i18n.t("notifications.enabledOnThisDevice"))).toBeInTheDocument();
  });

  it("does not touch the network when push is off on the server", async () => {
    fetchPushStatus.mockResolvedValue(false);
    renderPanel();

    await waitFor(() => expect(fetchPushStatus).toHaveBeenCalled());
    expect(resyncPushSubscription).not.toHaveBeenCalled();
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
