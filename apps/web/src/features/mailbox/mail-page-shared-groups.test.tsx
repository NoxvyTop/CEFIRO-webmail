import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";

// #340: the group appeared twice under the same name — GRUPOS opened the
// PERSONAL inbox filtered by recipient (which says "0 correos" when no copy
// ever landed there) and the shared-mailboxes page opened the group's own
// account. Neither showed unread. These cover the single merged entry, the
// unread counter it carries, the label list that used to leak across accounts,
// and the checkbox that never said which group it referred to.

const user = {
  userId: "u1",
  email: "primary@x.com",
  displayName: "Primary",
  role: "employee",
  locale: "es",
};

const identities = [
  { id: "i1", name: "Primary", email: "primary@x.com" },
  { id: "i2", name: "Soporte", email: "soporte@x.com" },
];

const sharedAccounts = [{ id: "acc-soporte", name: "soporte@x.com", copyOptIn: false }];

function mailbox(unreadEmails: number) {
  return [
    {
      id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox",
      sortOrder: 0, unreadEmails, totalEmails: unreadEmails,
    },
  ];
}

const labeledEmail = {
  id: "e1",
  threadId: "t1",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Alice", email: "alice@example.com" }],
  to: [],
  subject: "Personal mail",
  receivedAt: "2026-07-01T10:00:00.000Z",
  preview: "preview",
  keywords: { "solo-personal": true },
  hasAttachment: false,
  size: 100,
};

function stubFetch(options: { sharedUnread?: number } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/auth/me")) return new Response(JSON.stringify(user));
    if (url.includes("/api/mail/shared-accounts")) {
      return new Response(JSON.stringify(sharedAccounts));
    }
    if (url.includes("/api/mail/mailboxes")) {
      const shared = url.includes("accountId=acc-soporte");
      return new Response(JSON.stringify(mailbox(shared ? (options.sharedUnread ?? 0) : 0)));
    }
    if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(identities));
    if (url.includes("/api/mail/preferences") && method === "PUT") {
      return new Response(JSON.stringify({ groupMailInMainInbox: false }));
    }
    if (url.includes("/api/mail/preferences")) {
      return new Response(JSON.stringify({ groupMailInMainInbox: false }));
    }
    if (url.includes("/api/mail/messages")) {
      // The shared account carries no keywords of its own; the personal inbox
      // has one. That difference is what exposes the label leak.
      const shared = url.includes("accountId=acc-soporte");
      return new Response(
        JSON.stringify(
          shared ? { total: 0, position: 0, emails: [] } : { total: 1, position: 0, emails: [labeledEmail] },
        ),
      );
    }
    return new Response(JSON.stringify({ status: "ok", checks: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAt(path: string, options: { sharedUnread?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const fetchMock = stubFetch(options);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { fetchMock, router };
}

describe("sidebar group entries backed by shared mailboxes (#340)", () => {
  it("lists the group once, not once per view of it", async () => {
    renderAt("/");

    await screen.findByRole("navigation", { name: i18n.t("groups.title") });
    await waitFor(() =>
      expect(screen.getAllByText("soporte@x.com")).toHaveLength(1),
    );
  });

  it("carries the unread count of the group's own inbox", async () => {
    renderAt("/", { sharedUnread: 4 });

    const row = await screen.findByRole("button", {
      name: new RegExp(i18n.t("mail.unread", { count: 4 })),
    });
    expect(row).toHaveTextContent("soporte@x.com");
  });

  it("opens the group's shared account rather than the filtered personal inbox", async () => {
    const { fetchMock, router } = renderAt("/");

    await screen.findByRole("navigation", { name: i18n.t("groups.title") });
    fireEvent.click(screen.getByText("soporte@x.com"));

    await waitFor(() => expect(router.state.location.search).toContain("account=acc-soporte"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/mail/messages") && String(input).includes("accountId=acc-soporte"),
        ),
      ).toBe(true),
    );
    expect(router.state.location.search).not.toContain("group=");
  });

  it("drops the labels discovered in the personal mailbox when switching account", async () => {
    renderAt("/");

    // Discovered from the personal inbox's mail.
    expect(await screen.findByText("solo-personal")).toBeInTheDocument();

    fireEvent.click(screen.getByText("soporte@x.com"));

    // The shared account has no such keyword: the rail must not keep showing
    // a label that belongs to a mailbox the user is no longer looking at.
    await waitFor(() => expect(screen.queryByText("solo-personal")).not.toBeInTheDocument());
  });
});

describe("groupMailInMainInbox checkbox (#340)", () => {
  it("names the group it refers to", async () => {
    renderAt("/");

    expect(
      await screen.findByRole("checkbox", {
        name: i18n.t("groups.showInInbox", { groups: "soporte@x.com" }),
      }),
    ).toBeInTheDocument();
  });

  it("says plainly that it does not deliver copies, unlike the shared-mailbox opt-in", async () => {
    renderAt("/");

    expect(await screen.findByText(i18n.t("groups.showInInboxHelp"))).toBeInTheDocument();
  });

  it("is not offered on a view it does not affect", async () => {
    // It only ever changes what the MAIN inbox shows; on the group's own
    // mailbox it was noise sitting above a list it has no bearing on.
    renderAt("/?account=acc-soporte");

    await screen.findByRole("navigation", { name: i18n.t("groups.title") });
    await waitFor(() =>
      expect(
        screen.queryByRole("checkbox", {
          name: i18n.t("groups.showInInbox", { groups: "soporte@x.com" }),
        }),
      ).not.toBeInTheDocument(),
    );
  });
});
