import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";

// GH #177: below `lg` the sidebar collapses into a hamburger-toggled drawer so
// the mail list is reachable (not clipped to a sliver) on narrow viewports.
// jsdom applies no CSS, so these tests exercise the drawer's DOM/ARIA state
// machine (open/close, focus, modal semantics) rather than pixel layout — the
// visual collapse itself is driven by the `lg:` utility classes.

const user = {
  userId: "u1",
  email: "emp@noxvytop.com",
  displayName: "Emp",
  role: "employee",
  locale: "es",
};

const mailboxes = [
  {
    id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox",
    sortOrder: 0, unreadEmails: 3, totalEmails: 10,
  },
  {
    id: "mb-archive", name: "Archive", parentId: null, role: null,
    sortOrder: 1, unreadEmails: 0, totalEmails: 5,
  },
];

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/me")) return new Response(JSON.stringify(user));
      if (path.includes("/api/mail/mailboxes")) return new Response(JSON.stringify(mailboxes));
      if (path.includes("/api/mail/messages")) {
        return new Response(JSON.stringify({ total: 0, position: 0, emails: [] }));
      }
      return new Response(JSON.stringify({ status: "ok", checks: {} }));
    }),
  );
}

const navMenu = i18n.t("mail.navMenu");
const navRegion = i18n.t("mail.navRegion");
const closeNav = i18n.t("mail.closeNav");
const inboxName = i18n.t("mail.folders.inbox");

function drawer() {
  return screen.queryByRole("dialog", { name: navRegion });
}

describe("sidebar drawer (narrow viewports)", () => {
  it("keeps the mail list reachable while the drawer stays closed by default", async () => {
    stubFetch();
    renderAt("/");

    // The hamburger is the reachable entry point to the collapsed nav, and the
    // message list region is present alongside it — the list is no longer
    // hidden behind an always-expanded sidebar.
    const toggle = await screen.findByRole("button", { name: navMenu });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "mailbox-nav");
    expect(screen.getByRole("region", { name: i18n.t("mail.listRegion") })).toBeInTheDocument();

    // Closed drawer is not a modal dialog (so global shortcuts still fire).
    expect(drawer()).toBeNull();
  });

  it("opens the drawer as a modal dialog when the hamburger is pressed", async () => {
    stubFetch();
    renderAt("/");

    const toggle = await screen.findByRole("button", { name: navMenu });
    fireEvent.click(toggle);

    const dialog = await screen.findByRole("dialog", { name: navRegion });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("id", "mailbox-nav");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and returns focus to the hamburger", async () => {
    stubFetch();
    renderAt("/");

    const toggle = await screen.findByRole("button", { name: navMenu });
    // fireEvent.click doesn't move focus the way a real click does; focus the
    // toggle first so the trap captures it as the element to restore to on close.
    toggle.focus();
    fireEvent.click(toggle);
    await screen.findByRole("dialog", { name: navRegion });

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(drawer()).toBeNull());
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it("closes when its own close button is pressed", async () => {
    stubFetch();
    renderAt("/");

    fireEvent.click(await screen.findByRole("button", { name: navMenu }));
    await screen.findByRole("dialog", { name: navRegion });

    fireEvent.click(screen.getByRole("button", { name: closeNav }));

    await waitFor(() => expect(drawer()).toBeNull());
  });

  it("closes after a folder is chosen so the uncovered list is usable, and navigates", async () => {
    stubFetch();
    renderAt("/");

    fireEvent.click(await screen.findByRole("button", { name: navMenu }));
    const dialog = await screen.findByRole("dialog", { name: navRegion });

    // Pick a folder from inside the open drawer.
    const archive = within(dialog).getByText("Archive");
    fireEvent.click(archive);

    await waitFor(() => expect(drawer()).toBeNull());
    // The selection took effect (aria-current tracks the chosen mailbox).
    const [selected] = await screen.findAllByText("Archive");
    expect(selected!.closest("[aria-current]")).toHaveAttribute("aria-current", "true");
  });

  it("dismisses when the backdrop behind the drawer is clicked", async () => {
    stubFetch();
    renderAt("/");

    fireEvent.click(await screen.findByRole("button", { name: navMenu }));
    const dialog = await screen.findByRole("dialog", { name: navRegion });

    // The backdrop is the dialog's immediately-preceding sibling (aria-hidden).
    const backdrop = dialog.previousElementSibling as HTMLElement;
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(backdrop);

    await waitFor(() => expect(drawer()).toBeNull());
  });

  it("does not mark the sidebar as a dialog at all once nothing is open", async () => {
    stubFetch();
    renderAt("/");

    await screen.findByRole("button", { name: navMenu });
    // Inbox row is still present (queryable) even while the drawer is closed —
    // the nav content is only visually off-canvas, never removed.
    expect((await screen.findAllByText(inboxName)).length).toBeGreaterThan(0);
    expect(drawer()).toBeNull();
  });
});
