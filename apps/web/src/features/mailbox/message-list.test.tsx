import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomLabel, EmailSummary } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { ToastProvider } from "../../app/ui/toast";
import { labelBackground, labelColor } from "../../app/ui/labels";
import { MessageList } from "./MessageList";

// @tanstack/react-virtual measures the scroll container via
// getBoundingClientRect, which jsdom always reports as zero-sized — the
// virtualized branch would then compute an empty visible window and no rows
// mount. The rest of this file sidesteps that with virtualized={false}, but
// the GH #87 row-height fix below lives entirely inside the virtualizer's
// estimateSize/getVirtualItems output, so those specific tests need real
// rows; force the virtualizer to report every row as visible instead
// (mirrors draft-click-routing.test.tsx's mock, which forwards estimateSize
// per-index so a per-row size function is actually exercised).
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
    }),
  };
});

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

// GH #89: two messages in the same thread ("thread-group"), deliberately
// listed oldest-first in some tests below to prove the representative is
// chosen by receivedAt (latest wins), not by array position.
const threadGroupOlder = {
  id: "g1",
  threadId: "thread-group",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Frank", email: "frank@example.com" }],
  to: [],
  subject: "Original message",
  receivedAt: "2026-07-01T05:00:00.000Z",
  preview: "preview text six",
  keywords: { $seen: true },
  hasAttachment: false,
  size: 80,
};

const threadGroupNewer = {
  id: "g2",
  threadId: "thread-group",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Grace", email: "grace@example.com" }],
  to: [],
  subject: "Re: Original message",
  receivedAt: "2026-07-01T11:00:00.000Z",
  preview: "preview text seven",
  keywords: {},
  hasAttachment: false,
  size: 95,
};

const ventasCustomLabel: CustomLabel = { slug: "ventas-q3", name: "Ventas Q3", color: "#9B6BDB" };

const emailCustomLabeled = {
  id: "e5",
  threadId: "t5",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Erin", email: "erin@example.com" }],
  to: [],
  subject: "Custom labeled email",
  receivedAt: "2026-07-01T06:00:00.000Z",
  preview: "preview text five",
  keywords: { "ventas-q3": true, $seen: true },
  hasAttachment: false,
  size: 90,
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

// Mirrors how MailPage actually wires MessageList: selectedThreadId flows
// back in from the onSelect callback, so pressing j/k repeatedly advances
// selection like it would in the real app. The plain renderList() helper
// above always renders with selectedThreadId=null, which is enough for
// single-press tests but can't exercise multi-step keyboard navigation.
function ControlledMessageList({
  onSelect,
  overrides = {},
}: {
  onSelect: (email: EmailSummary) => void;
  overrides?: Partial<React.ComponentProps<typeof MessageList>>;
}) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  function handleSelect(email: EmailSummary) {
    onSelect(email);
    setSelectedThreadId(email.threadId);
  }
  return (
    <MessageList
      mailboxId="mb-inbox"
      query={null}
      selectedThreadId={selectedThreadId}
      onSelect={handleSelect}
      virtualized={false}
      archiveMailboxId={null}
      {...overrides}
    />
  );
}

function renderControlledList(overrides: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSelect = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ControlledMessageList onSelect={onSelect} overrides={overrides} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onSelect };
}

describe("MessageList", () => {
  it("renders rows from a page, marking the unread sender bold and the read one medium", async () => {
    stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    renderList();

    const unreadSender = await screen.findByText("Alice");
    expect(unreadSender).toHaveClass("font-bold");

    const readSender = await screen.findByText("bob@example.com");
    expect(readSender).toHaveClass("font-medium");
    expect(readSender).not.toHaveClass("font-bold");
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

  // Fresh review: custom-label chips in the list were resolving color via the
  // hash fallback and rendering the raw slug, while the Sidebar/reader showed
  // the stored color + display name for the same label — the list must match.
  it("renders a custom label's row chip with its stored color and display name, not the hash fallback / raw slug", async () => {
    stubFetch({ total: 1, position: 0, emails: [emailCustomLabeled] });
    renderList(vi.fn(), { customLabels: [ventasCustomLabel] });

    const chip = await screen.findByText("Ventas Q3");
    expect(chip).toHaveStyle({
      color: labelColor("ventas-q3", [ventasCustomLabel]),
      background: labelBackground("ventas-q3", [ventasCustomLabel]),
    });
    expect(chip).toHaveStyle({ color: "#9B6BDB" });
    expect(screen.queryByText("ventas-q3")).not.toBeInTheDocument();
  });

  it("renders the active label header chip with a custom label's stored color and display name", async () => {
    stubFetch({ total: 1, position: 0, emails: [emailCustomLabeled] });
    renderList(vi.fn(), { title: "Inbox", activeLabel: "ventas-q3", customLabels: [ventasCustomLabel] });

    const chip = await screen.findByText("Ventas Q3");
    expect(chip).toHaveStyle({ color: "#9B6BDB" });
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

  // GH #87: a virtualized row is wrapped in an absolutely-positioned box
  // whose height comes from the virtualizer's estimateSize — previously a
  // flat constant for every row. A row carrying a label chip renders taller
  // than that constant, so its content overflowed the box and bled into the
  // next row's absolutely-positioned box; since that box paints later in DOM
  // order, an opaque selected background (bg-sel) on the row below covered
  // the chip. The fix makes estimateSize grow for a labeled row so its box
  // actually fits the content — no overflow, nothing to paint over.
  describe("virtualized row sizing (GH #87)", () => {
    it("gives a virtualized row with a label chip a taller box than a plain row, so its content isn't overlapped by the row below", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailLabeled, emailRead] });
      renderList(vi.fn(), { virtualized: true });

      const labeledRow = (await screen.findByText("Labeled email")).closest('[role="option"]');
      const plainRow = (await screen.findByText(i18n.t("mail.noSubject"))).closest('[role="option"]');
      expect(labeledRow).toBeTruthy();
      expect(plainRow).toBeTruthy();

      // The row wrapper is the virtualizer's absolutely-positioned box —
      // it's the direct parent of the row content rendered by renderRow().
      const labeledWrapper = labeledRow!.parentElement as HTMLElement;
      const plainWrapper = plainRow!.parentElement as HTMLElement;

      const labeledHeight = parseFloat(labeledWrapper.style.height);
      const plainHeight = parseFloat(plainWrapper.style.height);

      expect(plainHeight).toBe(84);
      expect(labeledHeight).toBeGreaterThan(plainHeight);
    });

    it("gives two plain (label-less) rows the same box height", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
      renderList(vi.fn(), { virtualized: true });

      const firstRow = (await screen.findByText("Hello there")).closest('[role="option"]');
      const secondRow = (await screen.findByText(i18n.t("mail.noSubject"))).closest('[role="option"]');

      const firstHeight = parseFloat((firstRow!.parentElement as HTMLElement).style.height);
      const secondHeight = parseFloat((secondRow!.parentElement as HTMLElement).style.height);

      expect(firstHeight).toBe(secondHeight);
    });
  });

  // GH #89: the list showed one row per email, so a 5-message thread took up
  // 5 rows. Group loaded messages by threadId into one row per conversation,
  // Gmail-style, with a counter badge when a thread has more than one loaded
  // message.
  describe("conversation grouping (GH #89)", () => {
    it("renders one row per thread with a counter, keeping singleton threads as separate rows", async () => {
      stubFetch({ total: 3, position: 0, emails: [threadGroupNewer, threadGroupOlder, emailRead] });
      renderList();

      await screen.findByText("Grace");
      const options = screen.getAllByRole("option");
      // thread-group (2 loaded messages) + t2 (1 message) = 2 conversation rows.
      expect(options).toHaveLength(2);

      const counter = screen.getByLabelText(i18n.t("mail.conversationCount", { count: 2 }));
      expect(counter).toHaveTextContent("2");

      // The singleton thread must not render a counter at all.
      expect(screen.queryAllByLabelText(/./).filter((el) => el.textContent === "2")).toHaveLength(1);
    });

    it("shows the latest message's subject and sender as the conversation's representative, regardless of load order", async () => {
      // Oldest-first on purpose: proves the representative is chosen by
      // receivedAt, not by first occurrence in the loaded page.
      stubFetch({ total: 2, position: 0, emails: [threadGroupOlder, threadGroupNewer] });
      renderList();

      expect(await screen.findByText("Re: Original message")).toBeInTheDocument();
      expect(screen.getByText("Grace")).toBeInTheDocument();
      expect(screen.queryByText("Original message")).not.toBeInTheDocument();
      expect(screen.queryByText("Frank")).not.toBeInTheDocument();
    });

    it("clicking a conversation row opens that thread via the representative message (existing onSelect contract)", async () => {
      stubFetch({ total: 2, position: 0, emails: [threadGroupNewer, threadGroupOlder] });
      const { onSelect } = renderList();

      const row = (await screen.findByText("Re: Original message")).closest('[role="option"]');
      fireEvent.click(row!);

      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "g2", threadId: "thread-group" }));
    });

    it("moves selection by conversation with j, skipping over grouped messages within a thread", async () => {
      // The thread's second message (g1) is placed directly AFTER the
      // representative (g2), not last — this is deliberate. Per-email
      // navigation (the pre-grouping code) finds the FIRST email whose
      // threadId matches the selection via emails.findIndex, so after
      // selecting g2 it would resolve currentIndex back to g2's position (0)
      // every time, advance to g1 (index 1, same thread) on the 2nd press,
      // and then get stuck re-resolving to index 0 again on the 3rd press —
      // it can never advance past the group to t2/t3. Grouped navigation
      // must skip straight from g2 to t2 on the 2nd press. If the duplicate
      // were placed last instead, both implementations would happen to
      // produce the same 3-step sequence and this test wouldn't discriminate
      // between them (that was the original, non-discriminating fixture).
      stubFetch({
        total: 4,
        position: 0,
        emails: [threadGroupNewer, threadGroupOlder, emailRead, emailStarred],
      });
      const { onSelect } = renderControlledList();

      await screen.findByText("Grace");

      fireEvent.keyDown(window, { key: "j" });
      await vi.waitFor(() => {
        expect(onSelect).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "g2", threadId: "thread-group" }));
      });

      // The row directly AFTER the whole 2-message thread — not g1, the
      // thread's other loaded message.
      fireEvent.keyDown(window, { key: "j" });
      await vi.waitFor(() => {
        expect(onSelect).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "e2", threadId: "t2" }));
      });

      fireEvent.keyDown(window, { key: "j" });
      await vi.waitFor(() => {
        expect(onSelect).toHaveBeenNthCalledWith(3, expect.objectContaining({ id: "e3", threadId: "t3" }));
      });

      // 4th press: no more conversations — selection should not move again
      // (and must not somehow loop back into the thread).
      fireEvent.keyDown(window, { key: "j" });
      expect(onSelect).toHaveBeenCalledTimes(3);
    });

    it("shows the unread indicator when any loaded message in the thread is unread, even if the representative is read", async () => {
      const representativeRead = { ...threadGroupNewer, keywords: { $seen: true } };
      const olderUnread = { ...threadGroupOlder, keywords: {} };
      stubFetch({ total: 2, position: 0, emails: [representativeRead, olderUnread] });
      renderList();

      const sender = await screen.findByText("Grace");
      expect(sender).toHaveClass("font-bold");
    });

    // CRITICAL fix: `unread` became a thread-wide aggregate (true if ANY
    // loaded message in the thread is unread), but opening a conversation
    // only ever PATCHed the representative. A thread whose non-representative
    // message was unread (or whose representative was already seen while an
    // older message wasn't) could never be cleared through the UI — it
    // stayed bold forever. Opening a conversation must mark ALL of its
    // loaded messages seen, not just the representative.
    it("marks ALL loaded unread messages in a thread as seen when the conversation is opened, not just the representative", async () => {
      const representativeUnread = { ...threadGroupNewer, keywords: {} }; // g2 — unread
      const olderUnread = { ...threadGroupOlder, keywords: {} }; // g1 — also unread
      const fetchMock = stubFetch({ total: 2, position: 0, emails: [representativeUnread, olderUnread] });
      const { onSelect } = renderList();

      const sender = await screen.findByText("Grace");
      expect(sender).toHaveClass("font-bold");

      fireEvent.click(sender.closest('[role="option"]')!);

      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "g2", threadId: "thread-group" }));

      await vi.waitFor(() => {
        const patchedUrls = fetchMock.mock.calls
          .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
          .map(([input]) => String(input));
        expect(patchedUrls).toEqual(
          expect.arrayContaining(["/api/mail/messages/g2", "/api/mail/messages/g1"]),
        );
      });

      const patchBodies = fetchMock.mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
      for (const body of patchBodies) {
        expect(body).toEqual({ keywords: { $seen: true } });
      }

      // The optimistic update must flip the thread's aggregate unread
      // indicator off once both loaded messages are marked seen.
      await vi.waitFor(() => {
        expect(screen.getByText("Grace")).toHaveClass("font-medium");
      });
    });

    // WARNING fix: the pagination-trigger effect used to compare against
    // emails.length, which is wrong once grouping collapses rows — it must
    // compare against conversations.length instead, or fetchNextPage stops
    // firing before the visible window reaches the true end of the grouped
    // list. This test's fixture depends on the mocked useVirtualizer at the
    // top of this file, which reports every row (0..count-1) as visible.
    it("triggers fetchNextPage once the grouped rows reach the end of the loaded window (fewer conversations than raw emails)", async () => {
      // 4 raw emails collapse into 3 conversations (thread-group has 2
      // loaded messages). Under the mocked virtualizer, lastItem.index is
      // conversations.length - 1 (2) here. Comparing that against
      // emails.length - 1 (3) — the pre-fix bug — is never satisfied, so
      // fetchNextPage would never fire and position=4 would never be
      // requested.
      const firstPage = {
        total: 6,
        position: 0,
        emails: [threadGroupNewer, threadGroupOlder, emailRead, emailStarred],
      };
      const secondPage = { total: 6, position: 4, emails: [emailLabeled, emailCustomLabeled] };

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/api/mail/messages/") && method === "PATCH") {
          return new Response(null, { status: 204 });
        }
        if (url.includes("/api/mail/messages")) {
          const position = new URL(url, "http://local").searchParams.get("position");
          return new Response(JSON.stringify(position === "4" ? secondPage : firstPage));
        }
        return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
      });
      vi.stubGlobal("fetch", fetchMock);

      renderList(vi.fn(), { virtualized: true });

      await screen.findByText("Grace");

      await vi.waitFor(() => {
        const positions = fetchMock.mock.calls
          .filter(([input]) => String(input).includes("/api/mail/messages?"))
          .map(([input]) => new URL(String(input), "http://local").searchParams.get("position"));
        expect(positions).toContain("4");
      });
    });
  });
});
