import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mailbox } from "@webmail/shared";
import "../../app/i18n";
import { UNREAD_TITLE_BASE, useUnreadBadge } from "./useUnreadBadge";

// GH #338: with the tab visible nothing said mail had arrived. The unread count
// now reaches the one place a tab is always visible — its title.

const { fetchMailboxes } = vi.hoisted(() => ({ fetchMailboxes: vi.fn() }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchMailboxes };
});

function mailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: "mb-inbox",
    name: "Inbox",
    role: "inbox",
    parentId: null,
    totalEmails: 10,
    unreadEmails: 0,
    ...overrides,
  } as Mailbox;
}

function renderBadge() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useUnreadBadge(), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  document.title = UNREAD_TITLE_BASE;
});

afterEach(() => {
  document.title = UNREAD_TITLE_BASE;
});

describe("useUnreadBadge", () => {
  it("puts the Inbox unread count in the document title", async () => {
    fetchMailboxes.mockResolvedValue([mailbox({ unreadEmails: 3 })]);
    renderBadge();

    await waitFor(() => expect(document.title).toBe("(3) Céfiro"));
  });

  it("keeps the plain title when nothing is unread", async () => {
    fetchMailboxes.mockResolvedValue([mailbox({ unreadEmails: 0 })]);
    renderBadge();

    await waitFor(() => expect(fetchMailboxes).toHaveBeenCalled());
    expect(document.title).toBe(UNREAD_TITLE_BASE);
  });

  it("ignores mailboxes that are not the Inbox", async () => {
    fetchMailboxes.mockResolvedValue([
      mailbox({ id: "mb-junk", role: "junk", unreadEmails: 40 }),
    ]);
    renderBadge();

    await waitFor(() => expect(fetchMailboxes).toHaveBeenCalled());
    expect(document.title).toBe(UNREAD_TITLE_BASE);
  });

  it("restores the plain title when the mail screen is left", async () => {
    fetchMailboxes.mockResolvedValue([mailbox({ unreadEmails: 5 })]);
    const { unmount } = renderBadge();

    await waitFor(() => expect(document.title).toBe("(5) Céfiro"));
    unmount();
    expect(document.title).toBe(UNREAD_TITLE_BASE);
  });

  it("leaves the title alone when the mailbox list cannot be read", async () => {
    fetchMailboxes.mockRejectedValue(new Error("mail_credentials_missing"));
    renderBadge();

    await waitFor(() => expect(fetchMailboxes).toHaveBeenCalled());
    expect(document.title).toBe(UNREAD_TITLE_BASE);
  });
});
