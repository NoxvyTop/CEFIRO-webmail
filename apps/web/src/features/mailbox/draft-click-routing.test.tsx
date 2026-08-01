// NEW for feat/v3-edit-draft — kept in its own file (not composer.test.tsx,
// which a concurrent PR is also editing, and not wiring.test.tsx, to keep a
// clean, isolated diff for review).
//
// Covers Gmail-parity draft editing:
//   1. compose=draft:<id> resolves the composer with the draft's own fields
//      (not a reply/forward quote).
//   2. Clicking a message that carries the $draft keyword routes to the
//      composer instead of the read-only reader.
//   3. Clicking a normal (non-draft) message is unchanged: it still opens
//      the reader.
//   4. Sending an edited draft moves the ORIGINAL draft to Trash (best-effort
//      cleanup), so it doesn't linger as a stale copy — see useComposer.ts.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";

// @tanstack/react-virtual measures the scroll container via getBoundingClientRect,
// which jsdom always reports as zero-sized — MessageList's virtualized branch
// (the default; message-list.test.tsx sidesteps this by rendering with
// virtualized={false} directly) then computes an empty visible window and no
// rows mount. MailPage doesn't expose a virtualized override, so for these
// full-stack routing tests (which need real rows to click), force the
// virtualizer to report every row as visible instead.
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
      // GH #251: MessageList now scrolls the selected row into view. Every row
      // is already "visible" in this double, so the call has nothing to do —
      // but it must exist, or the selection effect throws.
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
  { id: "mb-drafts", name: "Drafts", parentId: null, role: "drafts", sortOrder: 1, unreadEmails: 0, totalEmails: 1 },
  { id: "mb-trash", name: "Trash", parentId: null, role: "trash", sortOrder: 2, unreadEmails: 0, totalEmails: 0 },
];

const identities = [{ id: "id1", name: "Alice", email: "alice@example.com" }];

const draftSummary = {
  id: "d1",
  threadId: "td1",
  mailboxIds: ["mb-drafts"],
  from: [{ name: "Alice", email: "alice@example.com" }],
  to: [{ name: "Bob", email: "bob@example.com" }],
  subject: "Draft subject",
  receivedAt: "2026-07-01T10:00:00.000Z",
  preview: "draft preview",
  keywords: { $draft: true },
  hasAttachment: false,
  size: 100,
};

const draftThread = {
  id: "td1",
  emails: [
    {
      ...draftSummary,
      cc: [],
      replyTo: [],
      bodyHtml: "<p>Draft body in progress</p>",
      bodyText: null,
      attachments: [],
      messageId: null,
      references: null,
      inReplyTo: null,
    },
  ],
};

const normalSummary = {
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

const normalThread = {
  id: "t1",
  emails: [
    {
      ...normalSummary,
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

function messagesPageFor(mailboxId: string | null) {
  if (mailboxId === "mb-drafts") return { total: 1, position: 0, emails: [draftSummary] };
  if (mailboxId === "mb-inbox") return { total: 1, position: 0, emails: [normalSummary] };
  return { total: 0, position: 0, emails: [] };
}

function stubFetch(options: { sendOk?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/api/auth/me")) return new Response(JSON.stringify(user));
    if (url.includes("/api/mail/mailboxes")) return new Response(JSON.stringify(mailboxes));
    if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(identities));
    if (url.includes("/api/mail/signatures")) return new Response(JSON.stringify([]));
    if (url.includes("/api/mail/threads/td1")) return new Response(JSON.stringify(draftThread));
    if (url.includes("/api/mail/threads/t1")) return new Response(JSON.stringify(normalThread));
    if (url.includes("/api/mail/messages/") && method === "PATCH") {
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes("/api/mail/messages")) {
      const params = new URL(url, "http://localhost").searchParams;
      return new Response(JSON.stringify(messagesPageFor(params.get("mailboxId"))));
    }
    if (url.includes("/api/mail/send") && method === "POST") {
      if (options.sendOk === false) {
        return new Response(JSON.stringify({ code: "send_failed" }), { status: 502 });
      }
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response(JSON.stringify({ status: "ok", checks: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAt(path: string, options: { sendOk?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const fetchMock = stubFetch(options);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { fetchMock };
}

describe("compose=draft:<id> resolution", () => {
  it("opens the composer at compose=draft:d1 with the draft's own subject/to/body — not a reply/forward quote", async () => {
    renderAt("/?mailbox=mb-drafts&thread=td1&compose=draft:d1");

    const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
    const subject = within(dialog).getByLabelText(i18n.t("composer.subject"));
    expect((subject as HTMLInputElement).value).toBe("Draft subject");
    // RecipientField chips display name || email — "Bob" here, matching how
    // the "Bob" name was set on draftSummary.to above.
    expect(within(dialog).getByText("Bob")).toBeInTheDocument();
  });
});

describe("draft-click routing", () => {
  it("clicking a message with the $draft keyword opens the composer instead of the reader", async () => {
    renderAt("/?mailbox=mb-drafts");

    const row = (await screen.findByText("Draft subject")).closest('[role="option"]');
    expect(row).toBeTruthy();
    fireEvent.click(row as HTMLElement);

    const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
    const subject = within(dialog).getByLabelText(i18n.t("composer.subject"));
    expect((subject as HTMLInputElement).value).toBe("Draft subject");
  });

  it("clicking a normal (non-draft) message still opens the read-only reader, unchanged", async () => {
    renderAt("/?mailbox=mb-inbox");

    const row = (await screen.findByText("Normal email")).closest('[role="option"]');
    expect(row).toBeTruthy();
    fireEvent.click(row as HTMLElement);

    await screen.findByTestId("thread-actions-bar");
    expect(
      screen.queryByRole("dialog", { name: i18n.t("composer.newMessage") }),
    ).not.toBeInTheDocument();
  });
});

describe("delete-on-send for an edited draft", () => {
  it("moves the original draft to Trash after successfully sending the edit", async () => {
    const { fetchMock } = renderAt("/?mailbox=mb-drafts&thread=td1&compose=draft:d1");

    const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
    const sendButton = within(dialog).getByRole("button", { name: i18n.t("composer.send") });
    fireEvent.click(sendButton);

    await vi.waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === "/api/mail/messages/d1" &&
          (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const [, init] = patchCall as [RequestInfo | URL, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ mailboxIds: { "mb-trash": true } });
    });
  });
});

// NEW — review follow-up: draft-click piggybacks `thread=<id>` on the
// compose URL purely to reuse the existing thread-fetch query (no
// single-email GET endpoint exists to fetch just the draft by id — see
// apps/server/src/modules/mail/router.ts). Left alone, that `thread` param
// would linger after the composer closes and the reader would show the
// (now sent-and-trashed, or just abandoned) draft thread. removeComposeParam
// clears `thread` too whenever the closing composer was in draft mode.
describe("clearing the piggybacked thread param when a draft-mode composer closes", () => {
  it("clears both compose and thread on Cancel, so the reader doesn't show the abandoned draft's thread", async () => {
    renderAt("/?mailbox=mb-drafts&thread=td1&compose=draft:d1");

    const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
    const cancelButton = within(dialog).getByRole("button", { name: i18n.t("composer.cancel") });
    fireEvent.click(cancelButton);

    // GH #159: Cancel now routes through the same discard confirmation as
    // Escape and the header close (X) button — this draft carries a subject
    // and a recipient, so it isn't empty and must confirm before closing.
    const discardButton = await screen.findByRole("button", {
      name: i18n.t("composer.discardConfirm.discard"),
    });
    fireEvent.click(discardButton);

    expect(
      screen.queryByRole("dialog", { name: i18n.t("composer.newMessage") }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-actions-bar")).not.toBeInTheDocument();
  });

  it("clears the thread param after a successful send, so the reader doesn't linger on the sent-and-trashed draft", async () => {
    renderAt("/?mailbox=mb-drafts&thread=td1&compose=draft:d1");

    const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
    const sendButton = within(dialog).getByRole("button", { name: i18n.t("composer.send") });
    fireEvent.click(sendButton);

    await vi.waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: i18n.t("composer.newMessage") }),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("thread-actions-bar")).not.toBeInTheDocument();
  });

  it("does NOT clear the thread param when closing a non-draft compose (e.g. reply), unchanged from prior behavior", async () => {
    renderAt("/?mailbox=mb-inbox&thread=t1&compose=reply:e1");

    const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.newMessage") });
    const cancelButton = within(dialog).getByRole("button", { name: i18n.t("composer.cancel") });
    fireEvent.click(cancelButton);

    // GH #159: replyDraft pre-fills `to` with the original sender, so this
    // composer isn't empty either — Cancel must confirm here too, same as
    // the draft-edit case above.
    const discardButton = await screen.findByRole("button", {
      name: i18n.t("composer.discardConfirm.discard"),
    });
    fireEvent.click(discardButton);

    expect(
      screen.queryByRole("dialog", { name: i18n.t("composer.newMessage") }),
    ).not.toBeInTheDocument();
    // Reply/forward never piggybacked `thread` — closing must keep showing
    // the reader for the thread the user was actually viewing.
    expect(await screen.findByTestId("thread-actions-bar")).toBeInTheDocument();
  });
});
