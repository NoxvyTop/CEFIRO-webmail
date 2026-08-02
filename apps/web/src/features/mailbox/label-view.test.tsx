import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { routes } from "../../app/routes";

const user = {
  userId: "u1",
  email: "primary@x.com",
  displayName: "Primary",
  role: "employee",
  locale: "es",
};

const mailboxes = [
  {
    id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox",
    sortOrder: 0, unreadEmails: 0, totalEmails: 0,
  },
  {
    id: "mb-archive", name: "Archive", parentId: null, role: null,
    sortOrder: 1, unreadEmails: 0, totalEmails: 0,
  },
  {
    id: "mb-trash", name: "Trash", parentId: null, role: "trash",
    sortOrder: 2, unreadEmails: 0, totalEmails: 0,
  },
];

const labeledEmail = {
  id: "e1",
  threadId: "t1",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Alice", email: "alice@example.com" }],
  to: [],
  subject: "Project update",
  receivedAt: "2026-07-01T10:00:00.000Z",
  preview: "preview text",
  keywords: { important: true, $seen: true },
  hasAttachment: false,
  size: 100,
};

const urgentEmail = {
  id: "e1",
  threadId: "t1",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Alice", email: "alice@example.com" }],
  to: [],
  subject: "Project update",
  receivedAt: "2026-07-01T10:00:00.000Z",
  preview: "preview text",
  keywords: { urgente: true, $seen: true },
  hasAttachment: false,
  size: 100,
};

const productoEmail = {
  id: "e2",
  threadId: "t2",
  mailboxIds: ["mb-inbox"],
  from: [{ name: "Bob", email: "bob@example.com" }],
  to: [],
  subject: "Feature request",
  receivedAt: "2026-07-02T10:00:00.000Z",
  preview: "feature preview",
  keywords: { producto: true, $seen: true },
  hasAttachment: false,
  size: 150,
};

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) return new Response(JSON.stringify(user));
    if (url.includes("/api/mail/mailboxes")) return new Response(JSON.stringify(mailboxes));
    if (url.includes("/api/mail/identities")) return new Response(JSON.stringify([]));
    if (url.includes("/api/mail/preferences")) {
      return new Response(JSON.stringify({ groupMailInMainInbox: false }));
    }
    if (url.includes("/api/mail/messages")) {
      // Return filtered or all emails based on the query
      if (url.includes("hasKeyword=important")) {
        return new Response(JSON.stringify({ total: 1, position: 0, emails: [labeledEmail] }));
      } else if (url.includes("hasKeyword=urgente")) {
        return new Response(JSON.stringify({ total: 1, position: 0, emails: [urgentEmail] }));
      } else {
        // Unfiltered - return all emails with different labels
        return new Response(JSON.stringify({ total: 3, position: 0, emails: [labeledEmail, urgentEmail, productoEmail] }));
      }
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

function messagesCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes("/api/mail/messages"));
}

describe("label view filtering", () => {
  // GH #106: a label view has no explicit `mailbox` param, so it must span
  // every folder (no mailboxId at all) instead of implicitly scoping to
  // Inbox — that implicit Inbox scoping was the root of the
  // folder-then-label accidental-intersection bug. It also excludes Trash
  // (see the excludeMailboxId assertion below).
  it("clicking a label in the sidebar requests hasKeyword=<label>, spans all folders (no mailboxId), and excludes Trash", async () => {
    const { fetchMock } = renderAt("/");

    await screen.findAllByText(i18n.t("mail.folders.inbox"));
    const labelRow = await screen.findByText("important");
    fireEvent.click(labelRow);

    const calls = await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      expect(found.some((url) => url.includes("hasKeyword=important"))).toBe(true);
      return found;
    });

    const labeledCall = calls.find((url) => url.includes("hasKeyword=important"));
    expect(labeledCall).not.toContain("mailboxId=");
    expect(labeledCall).toContain("excludeMailboxId=mb-trash");
  });

  it("clicking the same label again clears the filter and returns to the default Inbox-scoped view", async () => {
    const { fetchMock } = renderAt("/?label=important");

    await screen.findAllByText(i18n.t("mail.folders.inbox"));
    const labelsNav = await screen.findByRole("navigation", { name: i18n.t("mail.labels") });
    const labelRow = within(labelsNav).getByText("important");
    fireEvent.click(labelRow);

    await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      const last = found[found.length - 1];
      expect(last).toBeDefined();
      expect(last).not.toContain("hasKeyword");
      // Default view: back to Inbox scoping, no leftover Trash exclusion.
      expect(last).toContain("mailboxId=mb-inbox");
      expect(last).not.toContain("excludeMailboxId");
    });
  });

  // GH #106: clicking a FOLDER after a LABEL was active must clear the
  // label — otherwise the folder view silently intersects with it (the bug
  // reported in #106).
  it("selecting a folder while a label is active clears the label filter", async () => {
    const { fetchMock } = renderAt("/?mailbox=mb-archive&label=important");

    await screen.findAllByText(i18n.t("mail.folders.inbox"));
    const inboxRow = screen.getByText(i18n.t("mail.folders.inbox"));
    fireEvent.click(inboxRow);

    await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      const last = found[found.length - 1];
      expect(last).toBeDefined();
      expect(last).toContain("mailboxId=mb-inbox");
      expect(last).not.toContain("hasKeyword");
    });
  });

  // GH #106: clicking a LABEL after a FOLDER was active must clear the
  // mailbox (the view now spans folders, excluding Trash) instead of
  // intersecting with whatever folder was previously selected.
  it("selecting a label while a folder is active clears the mailbox filter and spans folders, excluding Trash", async () => {
    const { fetchMock } = renderAt("/?mailbox=mb-archive");

    await screen.findAllByText(i18n.t("mail.folders.inbox"));
    const labelRow = await screen.findByText("important");
    fireEvent.click(labelRow);

    const calls = await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      expect(found.some((url) => url.includes("hasKeyword=important"))).toBe(true);
      return found;
    });

    const labeledCall = calls.find((url) => url.includes("hasKeyword=important"));
    expect(labeledCall).not.toContain("mailboxId=");
    expect(labeledCall).toContain("excludeMailboxId=mb-trash");
  });

  // GH #106: same mutual-exclusivity rule applies to the starred and group
  // views — selecting a label replaces them rather than intersecting.
  it("selecting a label while starred is active clears starred (label wins, spans folders)", async () => {
    const { fetchMock } = renderAt("/?starred=1");

    await screen.findAllByText(i18n.t("mail.folders.inbox"));
    const labelRow = await screen.findByText("important");
    fireEvent.click(labelRow);

    const calls = await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      expect(found.some((url) => url.includes("hasKeyword=important"))).toBe(true);
      return found;
    });

    const labeledCall = calls.find((url) => url.includes("hasKeyword=important"));
    expect(labeledCall).not.toContain("mailboxId=");
    expect(labeledCall).not.toContain("%24flagged");
    expect(labeledCall).toContain("excludeMailboxId=mb-trash");
  });

  it("selecting a label while a group is active clears the group filter (label wins, spans folders)", async () => {
    const { fetchMock } = renderAt("/?group=soporte%40x.com");

    await screen.findAllByText(i18n.t("mail.folders.inbox"));
    const labelRow = await screen.findByText("important");
    fireEvent.click(labelRow);

    const calls = await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      expect(found.some((url) => url.includes("hasKeyword=important"))).toBe(true);
      return found;
    });

    const labeledCall = calls.find((url) => url.includes("hasKeyword=important"));
    expect(labeledCall).not.toContain("mailboxId=");
    expect(labeledCall).not.toContain("to=soporte");
    expect(labeledCall).toContain("excludeMailboxId=mb-trash");
  });

  it("label sidebar remains stable when a label filter is active", async () => {
    const { fetchMock } = renderAt("/");

    await screen.findAllByText(i18n.t("mail.folders.inbox"));
    const labelsNav = await screen.findByRole("navigation", { name: i18n.t("mail.labels") });

    // Both labels should be present initially
    await vi.waitFor(() => {
      expect(within(labelsNav).getByText("urgente")).toBeInTheDocument();
      expect(within(labelsNav).getByText("producto")).toBeInTheDocument();
    });

    // Click the urgente label to filter
    const urgenteLabel = within(labelsNav).getByText("urgente");
    fireEvent.click(urgenteLabel);

    // Wait for the filtered query to complete
    await vi.waitFor(() => {
      const calls = messagesCalls(fetchMock);
      expect(calls.some((url) => url.includes("hasKeyword=urgente"))).toBe(true);
    });

    // Both labels should still be visible in the sidebar despite the filter
    await vi.waitFor(() => {
      expect(within(labelsNav).getByText("urgente")).toBeInTheDocument();
      expect(within(labelsNav).getByText("producto")).toBeInTheDocument();
    });
  });
});
