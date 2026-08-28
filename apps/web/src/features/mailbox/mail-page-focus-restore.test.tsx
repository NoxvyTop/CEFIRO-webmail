// #348: closing the reader (via Archivar/Eliminar or the back button) used
// to leave focus wherever it happened to be when the underlying element
// disappeared — the browser's fallback is <body>, so a keyboard user landed
// nowhere recognizable and had to re-discover the message list from
// scratch. This is a full-stack MailPage render (not ThreadView in
// isolation) because the fix lives in the list section MailPage owns, not
// in ThreadView itself.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";

// Same double as draft-click-routing.test.tsx: jsdom always reports the
// virtualized scroll container as zero-sized, so force every row visible.
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => ({
      getVirtualItems: () =>
        Array.from({ length: options.count }, (_, index) => ({
          key: index,
          index,
          start: index * options.estimateSize(index),
          size: options.estimateSize(index),
        })),
      getTotalSize: () => options.count * options.estimateSize(0),
      scrollToIndex: () => {},
    }),
  };
});

const user = {
  userId: "u1",
  email: "alice@example.com",
  displayName: "Alice",
  role: "employee",
  locale: "es",
};

const mailboxes = [
  { id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox", sortOrder: 0, unreadEmails: 0, totalEmails: 1 },
  { id: "mb-archive", name: "Archive", parentId: null, role: "archive", sortOrder: 1, unreadEmails: 0, totalEmails: 0 },
  { id: "mb-trash", name: "Trash", parentId: null, role: "trash", sortOrder: 2, unreadEmails: 0, totalEmails: 0 },
];

const identities = [{ id: "id1", name: "Alice", email: "alice@example.com" }];

const summary = {
  id: "e1",
  threadId: "t1",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Carol", email: "carol@example.com" }],
  to: [{ name: "Alice", email: "alice@example.com" }],
  subject: "Normal email",
  receivedAt: "2026-07-01T09:00:00.000Z",
  preview: "normal preview",
  keywords: { $seen: true },
  hasAttachment: false,
  size: 100,
};

const thread = {
  id: "t1",
  emails: [
    {
      ...summary,
      cc: [],
      replyTo: [],
      bodyHtml: "<p>Normal body</p>",
      bodyText: null,
      attachments: [],
      messageId: null,
      references: null,
      inReplyTo: null,
    },
  ],
};

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/api/auth/me")) return new Response(JSON.stringify(user));
    if (url.includes("/api/mail/mailboxes")) return new Response(JSON.stringify(mailboxes));
    if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(identities));
    if (url.includes("/api/mail/signatures")) return new Response(JSON.stringify([]));
    if (url.includes("/api/mail/threads/t1")) return new Response(JSON.stringify(thread));
    if (url.includes("/api/mail/messages/e1") && method === "PATCH") {
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes("/api/mail/messages")) {
      const params = new URL(url, "http://localhost").searchParams;
      const inInbox = params.get("mailboxId") === "mb-inbox";
      return new Response(
        JSON.stringify({ total: inInbox ? 1 : 0, position: 0, emails: inInbox ? [summary] : [] }),
      );
    }
    return new Response(JSON.stringify({ status: "ok", checks: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const fetchMock = stubFetch();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { fetchMock };
}

describe("focus restored to the message list after closing the reader", () => {
  it("moves focus to the list region after archiving the open thread", async () => {
    renderAt("/?mailbox=mb-inbox&thread=t1");

    await screen.findByTestId("thread-actions-bar");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.archive") }));

    const listRegion = await screen.findByRole("region", { name: i18n.t("mail.listRegion") });
    await vi.waitFor(() => expect(listRegion).toHaveFocus());
  });

  it("moves focus to the list region when closing the reader via the back button", async () => {
    renderAt("/?mailbox=mb-inbox&thread=t1");

    await screen.findByTestId("thread-actions-bar");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.backToList") }));

    const listRegion = await screen.findByRole("region", { name: i18n.t("mail.listRegion") });
    await vi.waitFor(() => expect(listRegion).toHaveFocus());
  });

  it("does not steal focus on initial load, when no thread was ever open", async () => {
    renderAt("/?mailbox=mb-inbox");

    const listRegion = await screen.findByRole("region", { name: i18n.t("mail.listRegion") });
    await screen.findByText("Normal email");
    expect(listRegion).not.toHaveFocus();
  });
});
