import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { ToastProvider } from "../../app/ui/toast";
import { labelBackground, labelColor } from "../../app/ui/labels";
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

const emailStarred = {
  id: "e3",
  threadId: "t3",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Charlie", email: "charlie@example.com" }],
  to: [],
  subject: "Starred email",
  receivedAt: "2026-07-01T08:00:00.000Z",
  preview: "preview text three",
  keywords: { $flagged: true },
  hasAttachment: false,
  size: 150,
};

const emailLabeled = {
  id: "e4",
  threadId: "t4",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Dana", email: "dana@example.com" }],
  to: [],
  subject: "Labeled email",
  receivedAt: "2026-07-01T07:00:00.000Z",
  preview: "preview text four",
  keywords: { important: true, $seen: true },
  hasAttachment: false,
  size: 120,
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

function renderList(
  onSelect = vi.fn(),
  overrides: Partial<React.ComponentProps<typeof MessageList>> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MessageList
          mailboxId="mb-inbox"
          query={null}
          selectedThreadId={null}
          onSelect={onSelect}
          virtualized={false}
          archiveMailboxId={null}
          {...overrides}
        />
      </ToastProvider>
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

  it("renders up to 2 label chips for a row with user keywords", async () => {
    stubFetch({ total: 1, position: 0, emails: [emailLabeled] });
    renderList();

    const chip = await screen.findByText("important");
    expect(chip).toHaveClass("rounded-full");
    expect(chip).toHaveStyle({ color: labelColor("important"), background: labelBackground("important") });
  });

  it("calls onLabels with the union of user labels once messages load", async () => {
    stubFetch({ total: 1, position: 0, emails: [emailLabeled] });
    const onLabels = vi.fn();
    renderList(vi.fn(), { onLabels });

    await screen.findByText("Labeled email");
    await vi.waitFor(() => {
      expect(onLabels).toHaveBeenCalledWith(["important"]);
    });
  });

  it("shows the active label chip in the header with a clear button", async () => {
    stubFetch({ total: 1, position: 0, emails: [emailLabeled] });
    const onClearLabel = vi.fn();
    renderList(vi.fn(), { title: "Inbox", activeLabel: "important", onClearLabel });

    expect(await screen.findByText("important")).toBeInTheDocument();
    const clearButton = screen.getByRole("button", { name: i18n.t("mail.clearLabel") });
    fireEvent.click(clearButton);
    expect(onClearLabel).toHaveBeenCalled();
  });

  it("clicking the unstar button on a starred email toggles $flagged to false", async () => {
    const fetchMock = stubFetch({ total: 1, position: 0, emails: [emailStarred] });
    const { onSelect } = renderList();

    await screen.findByText("Starred email");
    const unstarButton = screen.getByRole("button", { name: i18n.t("mail.unstar") });
    fireEvent.click(unstarButton);

    expect(onSelect).not.toHaveBeenCalled();

    await screen.findByText("Starred email");
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/mail/messages/e3" && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    const [, init] = patchCall as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ keywords: { $flagged: false } });
  });

  it("pressing j with nothing selected opens the first email", async () => {
    stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    const { onSelect } = renderList();

    await screen.findByText("Hello there");
    fireEvent.keyDown(window, { key: "j" });

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));
  });

  it("pressing s toggles the star on the selected email", async () => {
    const fetchMock = stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    renderList(vi.fn(), { selectedThreadId: "t1" });

    await screen.findByText("Hello there");
    fireEvent.keyDown(window, { key: "s" });

    const patchCall = await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) => String(input) === "/api/mail/messages/e1" && (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(call).toBeTruthy();
      return call;
    });
    const [, init] = patchCall as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ keywords: { $flagged: true } });
  });

  it("pressing e archives the selected email when an archive mailbox exists", async () => {
    const fetchMock = stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    renderList(vi.fn(), { selectedThreadId: "t1", archiveMailboxId: "arch1" });

    await screen.findByText("Hello there");
    fireEvent.keyDown(window, { key: "e" });

    const patchCall = await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) => String(input) === "/api/mail/messages/e1" && (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(call).toBeTruthy();
      return call;
    });
    const [, init] = patchCall as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ mailboxIds: { arch1: true } });
  });

  it("ignores shortcut keys when the event target is an input", async () => {
    stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    const { onSelect } = renderList();

    await screen.findByText("Hello there");
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "j" });

    expect(onSelect).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  describe("relative time display", () => {
    beforeEach(() => {
      // shouldAdvanceTime keeps setTimeout-based polling (RTL's findBy*, React
      // Query's internals) moving in real time while Date.now() stays pinned
      // to the faked instant below.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date(2026, 6, 21, 14, 0, 0));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows a same-day email as a local time instead of an absolute date", async () => {
      const today = { ...emailUnread, receivedAt: new Date(2026, 6, 21, 10, 12, 0).toISOString() };
      stubFetch({ total: 1, position: 0, emails: [today] });
      renderList();

      expect(await screen.findByText("10:12")).toBeInTheDocument();
    });

    it("shows the localized yesterday label for a prior-day email", async () => {
      const yesterday = { ...emailUnread, receivedAt: new Date(2026, 6, 20, 9, 0, 0).toISOString() };
      stubFetch({ total: 1, position: 0, emails: [yesterday] });
      renderList();

      expect(await screen.findByText(i18n.t("mail.yesterday"))).toBeInTheDocument();
    });
  });
});
