import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { NotificationSettings } from "./NotificationSettings";

// GH #337 (b): the "Activar notificaciones" one-shot in the profile menu had no
// state, no way back and no relationship to the push panel. The in-tab
// permission now lives here, beside background push, in one section.

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

function stubNotification(permission: NotificationPermission, requested: NotificationPermission) {
  const requestPermission = vi.fn(async () => requested);
  vi.stubGlobal("Notification", { permission, requestPermission });
  return requestPermission;
}

beforeEach(() => {
  vi.clearAllMocks();
  isPushSupported.mockReturnValue(true);
  resyncPushSubscription.mockResolvedValue(false);
  fetchPushStatus.mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationSettings />
    </QueryClientProvider>,
  );
}

describe("NotificationSettings", () => {
  it("offers the in-tab permission when the browser has not been asked yet", async () => {
    stubNotification("default", "granted");
    renderSection();

    expect(
      await screen.findByRole("button", { name: i18n.t("notifications.browser.enable") }),
    ).toBeInTheDocument();
    expect(screen.getByText(i18n.t("notifications.browser.description"))).toBeInTheDocument();
  });

  it("asks for permission on click and then reports it as granted", async () => {
    const requestPermission = stubNotification("default", "granted");
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: i18n.t("notifications.browser.enable") }),
    );

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(i18n.t("notifications.browser.granted"))).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: i18n.t("notifications.browser.enable") }),
    ).not.toBeInTheDocument();
  });

  it("explains a denial instead of leaving a button that can no longer work", async () => {
    stubNotification("default", "denied");
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: i18n.t("notifications.browser.enable") }),
    );

    expect(await screen.findByText(i18n.t("notifications.browser.denied"))).toBeInTheDocument();
  });

  it("reports an already-granted permission without offering the button", () => {
    stubNotification("granted", "granted");
    renderSection();

    expect(screen.getByText(i18n.t("notifications.browser.granted"))).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: i18n.t("notifications.browser.enable") }),
    ).not.toBeInTheDocument();
  });

  it("says so when the browser has no Notification API at all", () => {
    vi.stubGlobal("Notification", undefined);
    renderSection();

    expect(screen.getByText(i18n.t("notifications.browser.unsupported"))).toBeInTheDocument();
  });

  it("keeps the background-push panel in the same section when the server has it off", async () => {
    stubNotification("granted", "granted");
    fetchPushStatus.mockResolvedValue(false);
    renderSection();

    expect(
      await screen.findByText(i18n.t("notifications.unavailableOnServer")),
    ).toBeInTheDocument();
  });
});
