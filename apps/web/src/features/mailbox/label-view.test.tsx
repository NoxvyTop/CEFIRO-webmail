import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
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
      return new Response(JSON.stringify({ total: 1, position: 0, emails: [labeledEmail] }));
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
  it("clicking a label in the sidebar requests hasKeyword=<label> while keeping the mailboxId", async () => {
    const { fetchMock } = renderAt("/");

    await screen.findAllByText("Inbox");
    const labelRow = await screen.findByText("important");
    fireEvent.click(labelRow);

    const calls = await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      expect(found.some((url) => url.includes("hasKeyword=important"))).toBe(true);
      return found;
    });

    const labeledCall = calls.find((url) => url.includes("hasKeyword=important"));
    expect(labeledCall).toContain("mailboxId=mb-inbox");
  });

  it("clicking the same label again clears the filter", async () => {
    const { fetchMock } = renderAt("/?label=important");

    await screen.findAllByText("Inbox");
    const labelsNav = await screen.findByRole("navigation", { name: i18n.t("mail.labels") });
    const labelRow = within(labelsNav).getByText("important");
    fireEvent.click(labelRow);

    await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      const last = found[found.length - 1];
      expect(last).toBeDefined();
      expect(last).not.toContain("hasKeyword");
    });
  });
});
