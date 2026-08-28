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
import { axeViolations, expectNoAxeViolations } from "../../test/axe";

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
      // GH #251: the selection effect calls this on every selection change.
      // This double renders the whole list, so there is never anything out of
      // view to scroll to — the windowed behaviour is exercised in
      // message-list-virtual-keyboard.test.tsx instead.
      scrollToIndex: () => {},
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

  describe("listbox roving tabindex and arrow navigation", () => {
    it("keeps only the selected option in the tab order, the rest at -1 (roving tabindex)", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
      renderList(vi.fn(), { selectedThreadId: "t2" });

      await screen.findByText("Hello there");
      const options = screen.getAllByRole("option");
      // emailUnread=t1 (first row), emailRead=t2 (selected) → only t2 tabbable.
      expect(options[0]).toHaveAttribute("tabindex", "-1");
      expect(options[1]).toHaveAttribute("tabindex", "0");
    });

    it("falls back to the first option in the tab order when nothing is selected", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
      renderList(vi.fn(), { selectedThreadId: null });

      await screen.findByText("Hello there");
      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("tabindex", "0");
      expect(options[1]).toHaveAttribute("tabindex", "-1");
    });

    it("opens the next conversation and moves focus to it on ArrowDown", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
      const { onSelect } = renderControlledList();

      await screen.findByText("Hello there");
      const options = screen.getAllByRole("option");
      options[0]!.focus();
      fireEvent.keyDown(options[0]!, { key: "ArrowDown" });

      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "e2" }));
      await vi.waitFor(() => expect(options[1]).toHaveFocus());
    });

    it("does nothing on ArrowUp from the first option (no conversation above it)", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
      const { onSelect } = renderList();

      await screen.findByText("Hello there");
      const options = screen.getAllByRole("option");
      fireEvent.keyDown(options[0]!, { key: "ArrowUp" });

      expect(onSelect).not.toHaveBeenCalled();
    });

    it("opens the focused conversation on Enter", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
      const { onSelect } = renderList();

      await screen.findByText("Hello there");
      const options = screen.getAllByRole("option");
      fireEvent.keyDown(options[0]!, { key: "Enter" });

      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));
    });
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
  // The virtualizer's own absolutely-positioned box for a row. GH #225 put a
  // presentational wrapper between it and the option (so the star button could
  // leave the option), so this climbs to the nearest ancestor the virtualizer
  // actually sized rather than assuming a fixed depth.
  function virtualRowBox(option: Element): HTMLElement {
    let current = option.parentElement;
    while (current && !current.style.height) current = current.parentElement;
    if (!current) throw new Error("no virtualized row box above this option");
    return current;
  }

  describe("virtualized row sizing (GH #87)", () => {
    it("gives a virtualized row with a label chip a taller box than a plain row, so its content isn't overlapped by the row below", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailLabeled, emailRead] });
      renderList(vi.fn(), { virtualized: true });

      const labeledRow = (await screen.findByText("Labeled email")).closest('[role="option"]');
      const plainRow = (await screen.findByText(i18n.t("mail.noSubject"))).closest('[role="option"]');
      expect(labeledRow).toBeTruthy();
      expect(plainRow).toBeTruthy();

      const labeledHeight = parseFloat(virtualRowBox(labeledRow!).style.height);
      const plainHeight = parseFloat(virtualRowBox(plainRow!).style.height);

      expect(plainHeight).toBe(84);
      expect(labeledHeight).toBeGreaterThan(plainHeight);
    });

    it("gives two plain (label-less) rows the same box height", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
      renderList(vi.fn(), { virtualized: true });

      const firstRow = (await screen.findByText("Hello there")).closest('[role="option"]');
      const secondRow = (await screen.findByText(i18n.t("mail.noSubject"))).closest('[role="option"]');

      const firstHeight = parseFloat(virtualRowBox(firstRow!).style.height);
      const secondHeight = parseFloat(virtualRowBox(secondRow!).style.height);

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

      // GH #253: the counter used to carry an aria-label on a plain <span>,
      // which no assistive tech reads — it is now a visible digit plus its own
      // screen-reader sentence, so the counted text is what to look for.
      const counter = screen.getByText(i18n.t("mail.conversationCount", { count: 2 }));
      expect(counter).toBeInTheDocument();
      expect(counter.parentElement).toHaveTextContent("2");

      // The singleton thread must not render a counter at all.
      expect(screen.queryAllByText(i18n.t("mail.conversationCount", { count: 1 }))).toHaveLength(0);
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

// GH #225: an automated a11y check over the list. It encodes, as executable
// assertions, the two ARIA rules the list was breaking — the same two an axe
// run reports as `aria-input-field-name` (a listbox with no accessible name)
// and `nested-interactive` (an option with focusable content). axe itself is
// not a dependency of this package; these assertions are written against the
// rendered accessibility-relevant DOM so the invariants are pinned either way.
describe("MessageList accessibility (GH #225)", () => {
  // Every way a browser will let the user Tab or click into something. Kept in
  // one place so "the option has no interactive descendants" is checked
  // against the whole set, not just <button>.
  const FOCUSABLE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "iframe",
    "[tabindex]",
    "[contenteditable]",
  ].join(", ");

  it("names both listboxes after the view they belong to", async () => {
    stubFetch({ total: 1, position: 0, emails: [emailUnread] });
    renderList(vi.fn(), { title: "Recibidos", virtualized: false });

    expect(await screen.findByRole("listbox", { name: "Recibidos" })).toBeInTheDocument();
  });

  it("names a headerless list generically rather than leaving it unnamed", async () => {
    stubFetch({ total: 1, position: 0, emails: [emailUnread] });
    renderList(vi.fn(), { virtualized: false });

    expect(
      await screen.findByRole("listbox", { name: i18n.t("mail.messageListLabel") }),
    ).toBeInTheDocument();
  });

  it("names the virtualized listbox too, not just the plain one", async () => {
    stubFetch({ total: 1, position: 0, emails: [emailUnread] });
    renderList(vi.fn(), { title: "Destacados", virtualized: true });

    expect(await screen.findByRole("listbox", { name: "Destacados" })).toBeInTheDocument();
  });

  it("leaves no focusable element inside any option", async () => {
    stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    renderList(vi.fn(), { virtualized: false });

    await screen.findByText("Hello there");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.querySelectorAll(FOCUSABLE_SELECTOR)).toHaveLength(0);
    }
  });

  it("keeps the star a real button, just outside the option", async () => {
    stubFetch({ total: 1, position: 0, emails: [emailUnread] });
    renderList(vi.fn(), { virtualized: false });

    const star = await screen.findByRole("button", { name: i18n.t("mail.star") });
    const option = screen.getByRole("option");
    expect(option.contains(star)).toBe(false);
    // Still in the same row, so it reads and looks exactly as before.
    expect(star.closest('[class*="border-b"]')).toBe(option.parentElement);
  });

  it("still stars from that button without opening the conversation", async () => {
    const fetchMock = stubFetch({ total: 1, position: 0, emails: [emailUnread] });
    const { onSelect } = renderList(vi.fn(), { virtualized: false });

    fireEvent.click(await screen.findByRole("button", { name: i18n.t("mail.star") }));

    expect(onSelect).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes("/api/mail/messages/") && init?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ keywords: { $flagged: true } });
    });
  });

  // GH #253: #225's comment already called the row wrapper "presentational",
  // but nothing in the markup said so. Left as a bare <div> it is `generic` in
  // the accessibility tree, so the listbox owned a container rather than an
  // option — and the virtualized branch stacked TWO of those between them.
  describe("the listbox owns its options directly (GH #253)", () => {
    it("marks every wrapper between the plain listbox and its options presentational", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
      renderList(vi.fn(), { virtualized: false });

      await screen.findByText("Hello there");
      const listbox = screen.getByRole("listbox");
      for (const option of screen.getAllByRole("option")) {
        let node = option.parentElement;
        while (node && node !== listbox) {
          expect(node).toHaveAttribute("role", "presentation");
          node = node.parentElement;
        }
      }
    });

    it("marks the virtualized branch's extra positioning wrappers presentational too", async () => {
      stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
      renderList(vi.fn(), { virtualized: true });

      await screen.findByText("Hello there");
      const listbox = screen.getByRole("listbox");
      const options = screen.getAllByRole("option");
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        let node = option.parentElement;
        while (node && node !== listbox) {
          expect(node).toHaveAttribute("role", "presentation");
          node = node.parentElement;
        }
      }
    });
  });

  it("keeps exactly one option in the tab order (roving tabindex, GH #200)", async () => {
    stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    renderList(vi.fn(), { virtualized: false });

    await screen.findByText("Hello there");
    const tabbable = screen
      .getAllByRole("option")
      .filter((option) => option.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
  });

  // GH #252: the same screen, checked by the real engine rather than by the
  // hand-written rules above. The assertions above stay: they pin the specific
  // invariants #200/#225/#253 fixed, in language that says WHY. This catches
  // everything nobody thought to write down.
  //
  // `aria-required-children` is the one rule excluded here, and it is excluded
  // knowingly (GH #253). A listbox may own only options, and #225 deliberately
  // moved the per-row star OUT of the option because an option's children are
  // presentational — a <button> inside one is announced by nothing. Both
  // placements break a rule; the current one at least leaves the star operable.
  // The real fix is role="grid"/row/gridcell, which is what a list of rows with
  // per-row controls actually is — a change to the public role contract that
  // six E2E specs and this file's own queries are written against, so it is a
  // deliberate follow-up rather than a side effect of this pass. Every other
  // axe rule is enforced.
  const LISTBOX_ROW_CONTROL_DEBT = ["aria-required-children"];

  it("passes an axe run over the rendered list", async () => {
    stubFetch({ total: 3, position: 0, emails: [emailUnread, emailRead, emailLabeled] });
    renderList(vi.fn(), { title: "Recibidos", virtualized: false });

    await screen.findByText("Hello there");
    await expectNoAxeViolations(document.body, LISTBOX_ROW_CONTROL_DEBT);
  });

  it("passes an axe run over the virtualized list too", async () => {
    stubFetch({ total: 3, position: 0, emails: [emailUnread, emailRead, emailLabeled] });
    renderList(vi.fn(), { title: "Recibidos", virtualized: true });

    await screen.findByText("Hello there");
    await expectNoAxeViolations(document.body, LISTBOX_ROW_CONTROL_DEBT);
  });

  // Pins the exclusion above to its ONE known cause, so the day the grid
  // conversion lands (or anything else adds a second disallowed child) this
  // fails and the exclusion has to be revisited rather than quietly widened.
  it("has exactly one known aria-required-children offender: the row's star button", async () => {
    stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    renderList(vi.fn(), { title: "Recibidos", virtualized: false });

    await screen.findByText("Hello there");
    const violations = await axeViolations(document.body);

    expect(violations.map((violation) => violation.id)).toEqual(["aria-required-children"]);
    for (const node of violations[0]?.nodes ?? []) {
      expect(node.failureSummary).toContain("button[aria-label]");
    }
  });
});

// GH #225: the star button left the option, so "the star of the row showing X"
// can no longer be found by descending into that option. The row wrapper is
// the handle that replaces it — pinned here because callers outside this
// package (the E2E suite) rely on it.
describe("MessageList row handle (GH #225)", () => {
  it("exposes each row as a single testable unit holding both the option and its star", async () => {
    stubFetch({ total: 2, position: 0, emails: [emailUnread, emailRead] });
    renderList(vi.fn(), { virtualized: false });

    await screen.findByText("Hello there");
    const rows = screen.getAllByTestId("conversation-row");
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row.querySelector('[role="option"]')).toBeTruthy();
      expect(row.querySelector("button")).toBeTruthy();
    }
  });
});

// GH #272: `isLoading` used to gate only the empty state, so switching folders
// left the list area blank until the first page arrived — indistinguishable
// from an empty folder. A skeleton now stands in for the pending first page.
describe("MessageList loading state (GH #272)", () => {
  it("shows a skeleton while the first page is still loading, not the empty state", async () => {
    // A fetch that never resolves keeps the infinite query in its pending state.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    renderList();

    expect(await screen.findByTestId("message-list-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("mail.empty"))).not.toBeInTheDocument();
  });

  it("replaces the skeleton with the empty state once an empty page arrives", async () => {
    stubFetch({ total: 0, position: 0, emails: [] });
    renderList();

    expect(await screen.findByText(i18n.t("mail.empty"))).toBeInTheDocument();
    expect(screen.queryByTestId("message-list-skeleton")).not.toBeInTheDocument();
  });
});

// GH #268: a search (`?q=`) turns the folder view into a search view. Before
// this the header still said the folder name and counted "N correos", so a
// short or empty result set read as "your inbox emptied".
describe("MessageList search header (GH #268)", () => {
  it("names the view as a search, shows the term, counts results, and clears back to the folder", async () => {
    stubFetch({ total: 1, position: 0, emails: [emailUnread] });
    const onClearSearch = vi.fn();
    renderList(vi.fn(), { title: "Recibidos", query: "factura", onClearSearch });

    await screen.findByText("Hello there");
    // The heading says it is a search, not the folder name.
    expect(screen.getByText(i18n.t("mail.searchResults"))).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recibidos" })).not.toBeInTheDocument();
    // The term is visible (in the clearable chip).
    expect(screen.getByText("factura")).toBeInTheDocument();
    // The count reads as results, never as the folder total.
    expect(screen.getByText(i18n.t("mail.searchResultCount", { count: 1 }))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("mail.messageCount", { count: 1 }))).not.toBeInTheDocument();
    // A visible way out, wired to onClearSearch.
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.clearSearch") }));
    expect(onClearSearch).toHaveBeenCalled();
  });

  it("still counts results (not the folder total) when a search returns nothing", async () => {
    stubFetch({ total: 0, position: 0, emails: [] });
    renderList(vi.fn(), { title: "Recibidos", query: "nada", onClearSearch: vi.fn() });

    expect(await screen.findByText(i18n.t("mail.empty"))).toBeInTheDocument();
    // The header still frames it as a search with zero results — so an empty
    // result cannot be misread as "the folder has 0 messages".
    expect(screen.getByText(i18n.t("mail.searchResults"))).toBeInTheDocument();
    expect(screen.getByText("nada")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("mail.searchResultCount", { count: 0 }))).toBeInTheDocument();
  });

  it("keeps the ordinary folder header and count when there is no query", async () => {
    stubFetch({ total: 3, position: 0, emails: [emailUnread] });
    renderList(vi.fn(), { title: "Recibidos" });

    await screen.findByText("Hello there");
    expect(screen.getByText("Recibidos")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("mail.messageCount", { count: 3 }))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("mail.searchResults"))).not.toBeInTheDocument();
  });
});

// #343: the rows are conversations, but archiving moved exactly one message —
// the newest one of the thread — so after "Archivar" the row stayed in
// Recibidos showing the previous message of the same conversation. And the
// archive mutation had no onError at all, so a 5xx/401 left the UI untouched
// with nothing said.
describe("MessageList — conversation-wide archive (#343)", () => {
  const groupOlderSent = {
    ...threadGroupOlder,
    id: "g0",
    mailboxIds: ["mb-sent"],
    receivedAt: "2026-07-01T04:00:00.000Z",
  };

  function renderForArchive(
    page: { total: number; position: number; emails: unknown[] },
    overrides: Partial<React.ComponentProps<typeof MessageList>> = {},
    patchResponse: () => Response = () => new Response(null, { status: 204 }),
  ) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/mail/messages/") && method === "PATCH") return patchResponse();
      if (url.includes("/api/mail/messages")) return new Response(JSON.stringify(page));
      return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MessageList
            mailboxId="mb-inbox"
            query={null}
            selectedThreadId="thread-group"
            onSelect={vi.fn()}
            virtualized={false}
            archiveMailboxId="arch1"
            {...overrides}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    return { fetchMock, invalidateSpy };
  }

  function archivePatchIds(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return fetchMock.mock.calls
      .filter(([input, init]) => {
        const body = (init as RequestInit | undefined)?.body;
        return (
          String(input).includes("/api/mail/messages/") &&
          (init as RequestInit | undefined)?.method === "PATCH" &&
          typeof body === "string" &&
          body.includes("mailboxIds")
        );
      })
      .map(([input]) => String(input).split("/").pop() as string);
  }

  it("pressing e archives every loaded message of the conversation, not only the newest", async () => {
    const { fetchMock } = renderForArchive({
      total: 2, position: 0, emails: [threadGroupNewer, threadGroupOlder],
    });

    await screen.findByText("Re: Original message");
    fireEvent.keyDown(window, { key: "e" });

    await vi.waitFor(() => expect(archivePatchIds(fetchMock).sort()).toEqual(["g1", "g2"]));
  });

  it("leaves alone the conversation's messages that are not in the mailbox being viewed", async () => {
    // g0 lives in Sent: archiving from Recibidos must not drag the sent copy
    // out of Enviados along with it.
    const { fetchMock } = renderForArchive({
      total: 3, position: 0, emails: [threadGroupNewer, threadGroupOlder, groupOlderSent],
    });

    await screen.findByText("Re: Original message");
    fireEvent.keyDown(window, { key: "e" });

    await vi.waitFor(() => expect(archivePatchIds(fetchMock).sort()).toEqual(["g1", "g2"]));
    expect(archivePatchIds(fetchMock)).not.toContain("g0");
  });

  it("tells the user when the archive fails instead of leaving the row silently unchanged", async () => {
    renderForArchive(
      { total: 2, position: 0, emails: [threadGroupNewer, threadGroupOlder] },
      {},
      () => new Response(JSON.stringify({ code: "database_unavailable" }), { status: 503 }),
    );

    await screen.findByText("Re: Original message");
    fireEvent.keyDown(window, { key: "e" });

    expect(await screen.findByRole("status")).toHaveTextContent(
      i18n.t("mail.errors.database_unavailable"),
    );
  });

  it("revalidates the session when the archive is refused with 401", async () => {
    const { invalidateSpy } = renderForArchive(
      { total: 2, position: 0, emails: [threadGroupNewer, threadGroupOlder] },
      {},
      () => new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 }),
    );

    await screen.findByText("Re: Original message");
    fireEvent.keyDown(window, { key: "e" });

    await vi.waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["auth", "me"] }),
    );
  });
});
