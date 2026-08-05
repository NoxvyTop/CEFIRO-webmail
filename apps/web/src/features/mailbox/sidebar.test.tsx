import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";
import { expectNoAxeViolations } from "../../test/axe";

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
      if (path.includes("/api/mail/shared-accounts")) return new Response(JSON.stringify([]));
      if (path.includes("/api/mail/mailboxes")) return new Response(JSON.stringify(mailboxes));
      if (path.includes("/api/mail/messages")) {
        return new Response(JSON.stringify({ total: 0, position: 0, emails: [] }));
      }
      return new Response(JSON.stringify({ status: "ok", checks: {} }));
    }),
  );
}

const inboxName = i18n.t("mail.folders.inbox");

describe("mailbox sidebar", () => {
  it("selects the inbox by role by default, shows its localized name, and the unread badge is visible", async () => {
    stubFetch();
    renderAt("/");

    // The mailbox name is also echoed in the message-list header, so scope to
    // the sidebar entry (rendered first) rather than asserting a single match.
    const [inbox] = await screen.findAllByText(inboxName);
    expect(await screen.findAllByText("Archive")).not.toHaveLength(0);
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(inbox!.closest("[aria-current]")).toHaveAttribute("aria-current", "true");
  });

  it("orders the primary nav Recibidos, Destacados, Enviados, Archivados", async () => {
    stubFetch();
    renderAt("/");

    await screen.findAllByText(inboxName);
    const nav = screen.getAllByRole("button").map((button) => button.textContent);
    const inboxIndex = nav.findIndex((text) => text?.includes(inboxName));
    const starredIndex = nav.findIndex((text) => text?.includes(i18n.t("mail.starredView")));
    const archiveIndex = nav.findIndex((text) => text?.includes("Archive"));

    expect(inboxIndex).toBeGreaterThanOrEqual(0);
    expect(starredIndex).toBeGreaterThan(inboxIndex);
    expect(archiveIndex).toBeGreaterThan(starredIndex);
  });

  it("selects the clicked mailbox via the URL", async () => {
    stubFetch();
    renderAt("/");

    await screen.findAllByText(inboxName);
    const [archive] = await screen.findAllByText("Archive");
    fireEvent.click(archive!);

    expect(await screen.findAllByText("Archive")).not.toHaveLength(0);
    expect(archive!.closest("[aria-current]")).toHaveAttribute("aria-current", "true");
  });

  // GH #13/#50 (G-4): shared mailboxes moved out of the header selector into
  // their own page, reached from a dedicated sidebar item.
  it("has a 'Buzones compartidos' item that navigates to the shared mailboxes page", async () => {
    stubFetch();
    renderAt("/");

    await screen.findAllByText(inboxName);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("sharedMailboxes.title") }));

    // The route changed to the page, which owns its own <h1> heading and, with
    // no shared mailboxes in this stub, its friendly empty state.
    expect(
      await screen.findByRole("heading", { name: i18n.t("sharedMailboxes.title") }),
    ).toBeInTheDocument();
    expect(await screen.findByText(i18n.t("sharedMailboxes.empty"))).toBeInTheDocument();
  });

  it("renders the starred entry and marks it current when the starred param is set", async () => {
    stubFetch();
    renderAt("/?starred=1");

    await screen.findAllByText(inboxName);
    const starredEntries = await screen.findAllByText("Destacados");
    const starredButton = starredEntries
      .map((el) => el.closest("button"))
      .find((button): button is HTMLButtonElement => button !== null);

    expect(starredButton).toHaveAttribute("aria-current", "true");
    const inbox = screen.getAllByText(inboxName)[0];
    expect(inbox!.closest("button")).not.toHaveAttribute("aria-current");
  });
});

// GH #252: the app had no automated accessibility check at all. This one runs
// the real axe engine over the whole mail screen as the router assembles it —
// app shell, sidebar and message list together — which is the level at which
// most ARIA defects actually appear (a landmark, a control named only by its
// icon, a role whose children do not match it).
describe("mail screen accessibility (GH #252)", () => {
  // See message-list.test.tsx: the per-row star button is not an allowed child
  // of a listbox, and both available placements break a rule. Excluded here for
  // the same documented reason and pinned there.
  const LISTBOX_ROW_CONTROL_DEBT = ["aria-required-children"];

  it("passes an axe run over the assembled mail screen", async () => {
    stubFetch();
    renderAt("/");

    await screen.findAllByText(inboxName);
    await expectNoAxeViolations(document.body, LISTBOX_ROW_CONTROL_DEBT);
  });

  it("passes an axe run with the label dialog open", async () => {
    stubFetch();
    renderAt("/");

    await screen.findAllByText(inboxName);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.newLabel") }));

    await screen.findByRole("dialog", { name: i18n.t("mail.newLabel") });
    await expectNoAxeViolations(document.body, LISTBOX_ROW_CONTROL_DEBT);
  });
});
