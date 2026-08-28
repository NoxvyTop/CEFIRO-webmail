import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import "../i18n";
import i18n from "../i18n";
import { UserMenu } from "./UserMenu";

const baseUser = {
  email: "carla@noxvytop.com",
  displayName: "Carla Bosch",
  role: "employee",
};

function renderMenu(overrides: Partial<Parameters<typeof UserMenu>[0]> = {}) {
  const onToggleTheme = vi.fn();
  const onLogout = vi.fn();
  const onEnableNotifications = vi.fn();
  const onShowShortcuts = vi.fn();
  const props = {
    user: baseUser,
    theme: "night" as const,
    onToggleTheme,
    onLogout,
    notificationPermission: "granted" as NotificationPermission,
    onEnableNotifications,
    onShowShortcuts,
    ...overrides,
  };
  const utils = render(
    <MemoryRouter>
      <UserMenu {...props} />
    </MemoryRouter>,
  );
  return { ...utils, onToggleTheme, onLogout, onEnableNotifications, onShowShortcuts };
}

describe("UserMenu", () => {
  it("is closed by default", () => {
    renderMenu();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens on avatar click and shows settings and logout items", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Sesión iniciada como carla@noxvytop.com/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Ajustes/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Cerrar sesión/ })).toBeInTheDocument();
  });

  it("only shows the admin item when the user is an admin", () => {
    renderMenu({ user: { ...baseUser, role: "employee" } });
    fireEvent.click(screen.getByRole("button", { name: /Sesión iniciada como carla@noxvytop.com/ }));
    expect(screen.queryByRole("menuitem", { name: /Administración/ })).not.toBeInTheDocument();

    renderMenu({ user: { ...baseUser, role: "admin" } });
    const buttons = screen.getAllByRole("button", { name: /Sesión iniciada como carla@noxvytop.com/ });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(screen.getByRole("menuitem", { name: /Administración/ })).toBeInTheDocument();
  });

  it("closes when Escape is pressed", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Sesión iniciada como carla@noxvytop.com/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("calls onLogout when the logout item is clicked", () => {
    const { onLogout } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Sesión iniciada como carla@noxvytop.com/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Cerrar sesión/ }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  // GH #13/#50 (G-4): the "Atajos" launcher moved from a standalone header
  // button into this menu; it must still open the shortcuts dialog.
  it("shows an Atajos item that fires onShowShortcuts and closes the menu", () => {
    const { onShowShortcuts } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Sesión iniciada como carla@noxvytop.com/ }));

    const atajos = screen.getByRole("menuitem", { name: /Atajos/ });
    expect(atajos).toBeInTheDocument();
    fireEvent.click(atajos);

    expect(onShowShortcuts).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

// GH #337 (b): the item used to be a one-shot with no visible outcome — it
// vanished whatever the user answered, and a browser that had already blocked
// alerts showed nothing at all. The permission itself now drives it.
describe("UserMenu notification item (GH #337)", () => {
  function openMenu() {
    fireEvent.click(screen.getByRole("button", { name: /Sesión iniciada como carla@noxvytop.com/ }));
  }

  it("offers the item while the browser has not been asked", () => {
    const { onEnableNotifications } = renderMenu({ notificationPermission: "default" });
    openMenu();

    const item = screen.getByRole("menuitem", { name: i18n.t("mail.enableNotifications") });
    expect(item).toBeEnabled();
    fireEvent.click(item);
    expect(onEnableNotifications).toHaveBeenCalledTimes(1);
  });

  it("hides the item once permission was granted", () => {
    renderMenu({ notificationPermission: "granted" });
    openMenu();

    expect(
      screen.queryByRole("menuitem", { name: i18n.t("mail.enableNotifications") }),
    ).not.toBeInTheDocument();
  });

  it("keeps a disabled, explanatory item when the browser blocked alerts", () => {
    const { onEnableNotifications } = renderMenu({ notificationPermission: "denied" });
    openMenu();

    const item = screen.getByRole("menuitem", { name: i18n.t("mail.notificationsBlocked") });
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(onEnableNotifications).not.toHaveBeenCalled();
  });

  it("shows nothing when the browser has no Notification API", () => {
    renderMenu({ notificationPermission: null });
    openMenu();

    expect(
      screen.queryByRole("menuitem", { name: i18n.t("mail.enableNotifications") }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: i18n.t("mail.notificationsBlocked") }),
    ).not.toBeInTheDocument();
  });
});
