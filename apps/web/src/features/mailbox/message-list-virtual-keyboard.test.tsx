import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSummary } from "@webmail/shared";
import "../../app/i18n";
import { ToastProvider } from "../../app/ui/toast";
import { MessageList } from "./MessageList";

// GH #251: the list is virtualized, so only a window of rows exists in the
// DOM at any moment. message-list.test.tsx deliberately mocks that away (its
// double renders every row) — which is exactly why nothing there could catch
// keyboard navigation walking off the end of the window.
//
// This double keeps a real window: a fixed number of rows around a scroll
// position that only `scrollToIndex` moves. Anything outside it is absent from
// the DOM, has no entry in the component's optionRefs, and cannot be focused —
// the same conditions that made ArrowDown drop focus to <body> and left the
// roving tabindex pointing at an element that did not exist.
const WINDOW_SIZE = 5;
const TOTAL_ROWS = 40;

vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  const react = await import("react");
  return {
    ...actual,
    useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => {
      const [requestedStart, setRequestedStart] = react.useState(0);
      const rowHeight = options.estimateSize(0);
      const maxStart = Math.max(0, options.count - WINDOW_SIZE);
      const first = Math.min(Math.max(requestedStart, 0), maxStart);
      const last = Math.min(options.count - 1, first + WINDOW_SIZE - 1);

      return {
        getVirtualItems: () =>
          Array.from({ length: Math.max(0, last - first + 1) }, (_unused, offset) => {
            const index = first + offset;
            return { key: index, index, start: index * rowHeight, size: rowHeight };
          }),
        getTotalSize: () => options.count * rowHeight,
        // Mirrors `align: "auto"`: move only as far as needed to bring the row
        // inside the window, and not at all when it is already there.
        scrollToIndex: (index: number) => {
          setRequestedStart((current) => {
            const clamped = Math.min(Math.max(current, 0), maxStart);
            if (index < clamped) return index;
            if (index > clamped + WINDOW_SIZE - 1) return index - WINDOW_SIZE + 1;
            return clamped;
          });
        },
      };
    },
  };
});

// All read ($seen) so selecting a row never fires the mark-as-seen PATCH —
// this file is about focus and scrolling, not about the mutation.
function emailAt(index: number): EmailSummary {
  return {
    id: `e${index}`,
    threadId: `t${index}`,
    mailboxIds: ["mb-inbox"],
    from: [{ name: `Sender ${index}`, email: `s${index}@example.com` }],
    to: [],
    subject: `Subject ${index}`,
    receivedAt: new Date(Date.UTC(2026, 6, 1, 12, 0, 0) - index * 60_000).toISOString(),
    preview: `preview ${index}`,
    keywords: { $seen: true },
    hasAttachment: false,
    size: 100,
  };
}

const emails = Array.from({ length: TOTAL_ROWS }, (_unused, index) => emailAt(index));

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/mail/messages")) {
        return new Response(JSON.stringify({ total: emails.length, position: 0, emails }));
      }
      return new Response(JSON.stringify({ code: "internal" }), { status: 500 });
    }),
  );
}

// Mirrors MailPage: selection is owned by the parent and flows back in as a
// prop, which is what makes the scroll effect fire. The extra button lets a
// test clear the selection without touching the list, so the roving tabindex
// can be observed while the preferred holder is outside the window.
function Harness() {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  return (
    <>
      <button type="button" onClick={() => setSelectedThreadId(null)}>
        clear selection
      </button>
      <MessageList
        mailboxId="mb-inbox"
        query={null}
        selectedThreadId={selectedThreadId}
        onSelect={(email) => setSelectedThreadId(email.threadId)}
        virtualized
        archiveMailboxId={null}
      />
    </>
  );
}

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function renderedSubjects(): string[] {
  return screen
    .getAllByRole("option")
    .map((option) => option.textContent ?? "")
    .map((text) => /Subject \d+/.exec(text)?.[0] ?? "")
    .filter(Boolean);
}

function optionFor(index: number): HTMLElement {
  return screen.getByText(`Subject ${index}`).closest('[role="option"]') as HTMLElement;
}

// The first j selects the FIRST conversation (nothing is selected before it),
// so landing on index N takes N + 1 presses.
function pressJUntil(index: number) {
  for (let step = 0; step <= index; step += 1) {
    fireEvent.keyDown(window, { key: "j" });
  }
}

function pressK(times: number) {
  for (let step = 0; step < times; step += 1) {
    fireEvent.keyDown(window, { key: "k" });
  }
}

describe("MessageList keyboard navigation across the virtual window (GH #251)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetch();
  });

  it("only renders a window of the list, so navigation has somewhere to fall off", async () => {
    renderList();

    await screen.findByText("Subject 0");
    expect(screen.getAllByRole("option")).toHaveLength(WINDOW_SIZE);
    expect(screen.queryByText(`Subject ${WINDOW_SIZE}`)).not.toBeInTheDocument();
  });

  it("scrolls the selection into view as j walks past the bottom of the window", async () => {
    renderList();

    await screen.findByText("Subject 0");
    // Row 10 is twice the window away, so nothing about the starting window can
    // make this pass by accident.
    pressJUntil(10);

    await waitFor(() => expect(screen.getByText("Subject 10")).toBeInTheDocument());
    expect(optionFor(10)).toHaveAttribute("aria-selected", "true");
    // The window really moved rather than growing.
    expect(renderedSubjects()).toHaveLength(WINDOW_SIZE);
    expect(screen.queryByText("Subject 0")).not.toBeInTheDocument();
  });

  it("scrolls back up as k walks past the top of the window", async () => {
    renderList();

    await screen.findByText("Subject 0");
    pressJUntil(10);
    await waitFor(() => expect(screen.getByText("Subject 10")).toBeInTheDocument());

    pressK(8);

    await waitFor(() => expect(screen.getByText("Subject 2")).toBeInTheDocument());
    expect(optionFor(2)).toHaveAttribute("aria-selected", "true");
  });

  it("keeps focus on the option ArrowDown moved to, even when it was outside the window", async () => {
    renderList();

    await screen.findByText("Subject 0");
    const lastRendered = optionFor(WINDOW_SIZE - 1);
    lastRendered.focus();
    expect(lastRendered).toHaveFocus();

    // One step beyond the window: before this fix optionRefs had no entry for
    // the target, the optional chain silently did nothing, and focus dropped to
    // <body> the moment the old row unmounted.
    fireEvent.keyDown(lastRendered, { key: "ArrowDown" });

    await waitFor(() => expect(optionFor(WINDOW_SIZE)).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("never leaves focus on <body> while ArrowDown walks the whole list", async () => {
    renderList();

    await screen.findByText("Subject 0");
    optionFor(0).focus();

    for (let index = 0; index < 12; index += 1) {
      const active = document.activeElement as HTMLElement;
      fireEvent.keyDown(active, { key: "ArrowDown" });
      await waitFor(() => expect(optionFor(index + 1)).toHaveFocus());
    }
  });

  it("carries focus along with j so the unmounted row does not take it to <body>", async () => {
    renderList();

    await screen.findByText("Subject 0");
    optionFor(0).focus();

    pressJUntil(8);

    await waitFor(() => expect(optionFor(8)).toHaveFocus());
  });

  it("leaves focus alone when j is pressed from outside the list", async () => {
    renderList();

    await screen.findByText("Subject 0");
    const outside = screen.getByRole("button", { name: "clear selection" });
    outside.focus();

    fireEvent.keyDown(window, { key: "j" });

    // j still moves the selection — it just must not yank focus out of
    // whatever the user was actually on.
    await waitFor(() => expect(optionFor(0)).toHaveAttribute("aria-selected", "true"));
    expect(outside).toHaveFocus();
  });

  it("always keeps exactly one RENDERED option in the tab order", async () => {
    renderList();

    await screen.findByText("Subject 0");
    pressJUntil(10);
    await waitFor(() => expect(screen.getByText("Subject 10")).toBeInTheDocument());

    const tabbable = screen
      .getAllByRole("option")
      .filter((option) => option.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(optionFor(10));
  });

  it("falls back to a rendered option when the preferred holder is outside the window", async () => {
    renderList();

    await screen.findByText("Subject 0");
    pressJUntil(10);
    await waitFor(() => expect(screen.getByText("Subject 10")).toBeInTheDocument());

    // Nothing selected → the preferred tab-stop holder is the FIRST
    // conversation, which is far above the current window and has no element.
    // Without the fallback the listbox has no tabbable option at all and Tab
    // skips straight past it.
    fireEvent.click(screen.getByRole("button", { name: "clear selection" }));

    await waitFor(() => {
      const tabbable = screen
        .getAllByRole("option")
        .filter((option) => option.getAttribute("tabindex") === "0");
      expect(tabbable).toHaveLength(1);
    });
    expect(screen.queryByText("Subject 0")).not.toBeInTheDocument();
  });
});
