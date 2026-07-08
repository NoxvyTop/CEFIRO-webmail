import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { MessageList } from "./MessageList";

const emailUnread = {
  id: "e1",
  threadId: "t1",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Alice", email: "alice@example.com" }],
  to: [],
  subject: "Hello there",
  receivedAt: "2026-07-01T10:00:00.000Z",
  preview: "preview text one",
  keywords: {},
  hasAttachment: false,
  size: 100,
};

const emailRead = {
  id: "e2",
  threadId: "t2",
  mailboxIds: ["mb-inbox"],
  from: [{ name: null, email: "bob@example.com" }],
  to: [],
  subject: "",
  receivedAt: "2026-07-01T09:00:00.000Z",
  preview: "preview text two",
  keywords: { $seen: true },
  hasAttachment: false,
  size: 200,
};

function stubFetch(page: { total: number; position: number; emails: unknown[] }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/mail/messages/") && method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/mail/messages")) {
      return new Response(JSON.stringify(page));
    }
    return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderList(onSelect = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessageList
        mailboxId="mb-inbox"
        query={null}
        selectedThreadId={null}
        onSelect={onSelect}
        virtualized={false}
      />
    </QueryClientProvider>,
  );
  return { onSelect };
}

describe("MessageList", () => {
  it("renders rows from a page, marking the unread one as bold", async () => {
    stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    renderList();

    const unreadSubject = await screen.findByText("Hello there");
    const unreadRow = unreadSubject.closest('[role="option"]');
    expect(unreadRow).toHaveClass("font-semibold");

    const readSubject = await screen.findByText(i18n.t("mail.noSubject"));
    const readRow = readSubject.closest('[role="option"]');
    expect(readRow).not.toHaveClass("font-semibold");
  });

  it("shows the empty state when there are no messages", async () => {
    stubFetch({ total: 0, position: 0, emails: [] });
    renderList();

    expect(await screen.findByText(i18n.t("mail.empty"))).toBeInTheDocument();
  });

  it("selects an unread row and optimistically marks it as seen via PATCH", async () => {
    const fetchMock = stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    const { onSelect } = renderList();

    const unreadSubject = await screen.findByText("Hello there");
    fireEvent.click(unreadSubject.closest('[role="option"]')!);

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));

    await screen.findByText("Hello there");
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/mail/messages/e1" && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    const [, init] = patchCall as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ keywords: { $seen: true } });
  });

  it("does not PATCH when clicking an already-read row", async () => {
    const fetchMock = stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    const { onSelect } = renderList();

    const readSubject = await screen.findByText(i18n.t("mail.noSubject"));
    fireEvent.click(readSubject.closest('[role="option"]')!);

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "e2" }));

    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeUndefined();
  });

  it("shows a star button on each row with the not-starred label", async () => {
    stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    renderList();

    await screen.findByText("Hello there");
    const starButtons = screen.getAllByRole("button", { name: i18n.t("mail.star") });
    expect(starButtons).toHaveLength(2);
  });

  it("clicking the star button toggles $flagged without selecting the row", async () => {
    const fetchMock = stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    const { onSelect } = renderList();

    await screen.findByText("Hello there");
    const starButtons = screen.getAllByRole("button", { name: i18n.t("mail.star") });
    fireEvent.click(starButtons[0]!);

    expect(onSelect).not.toHaveBeenCalled();

    await screen.findByText("Hello there");
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/mail/messages/e1" && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    const [, init] = patchCall as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ keywords: { $flagged: true } });
  });
});
