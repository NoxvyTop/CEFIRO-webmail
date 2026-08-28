import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import "../i18n";
import i18n from "../i18n";
import { AppUserMenu } from "./AppUserMenu";
import { ToastProvider } from "./toast";

// GH #337 (b): "Activar notificaciones" used to call requestPermission() and
// say nothing at all — no toast, no state, no way to tell granted from denied.

const user = { email: "carla@noxvytop.com", displayName: "Carla Bosch", role: "employee" };

function stubNotification(permission: NotificationPermission, requested: NotificationPermission) {
  const requestPermission = vi.fn(async () => requested);
  vi.stubGlobal("Notification", { permission, requestPermission });
  return requestPermission;
}

function renderMenu() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <AppUserMenu
          user={user}
          theme="night"
          onToggleTheme={vi.fn()}
          onLogout={vi.fn()}
          onShowShortcuts={vi.fn()}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Sesión iniciada como carla@noxvytop.com/ }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppUserMenu", () => {
  it("confirms a granted permission with a toast and drops the item", async () => {
    const requestPermission = stubNotification("default", "granted");
    renderMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("mail.enableNotifications") }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toHaveTextContent(
      i18n.t("notifications.browser.granted"),
    );
    expect(
      screen.queryByRole("menuitem", { name: i18n.t("mail.enableNotifications") }),
    ).not.toBeInTheDocument();
  });

  it("explains a denial with a toast and leaves the item blocked", async () => {
    stubNotification("default", "denied");
    renderMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("mail.enableNotifications") }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      i18n.t("notifications.browser.denied"),
    );
    expect(
      await screen.findByRole("menuitem", { name: i18n.t("mail.notificationsBlocked") }),
    ).toBeDisabled();
  });

  it("offers nothing when the browser has no Notification API", () => {
    vi.stubGlobal("Notification", undefined);
    renderMenu();

    expect(
      screen.queryByRole("menuitem", { name: i18n.t("mail.enableNotifications") }),
    ).not.toBeInTheDocument();
  });
});
