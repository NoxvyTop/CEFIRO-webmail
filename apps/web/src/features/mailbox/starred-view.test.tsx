import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
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
    id: "mb-archive", name: "Archive", parentId: null, role: "archive",
    sortOrder: 1, unreadEmails: 0, totalEmails: 0,
  },
];

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
      return new Response(JSON.stringify({ total: 0, position: 0, emails: [] }));
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

describe("starred view", () => {
  it("clicking Destacados requests flagged messages without a mailboxId and shows the starred title", async () => {
    const { fetchMock } = renderAt("/");

    await screen.findAllByText(i18n.t("mail.folders.inbox"));
    const starredEntry = await screen.findByText(i18n.t("mail.starredView"));
    fireEvent.click(starredEntry);

    expect(await screen.findByRole("heading", { name: i18n.t("mail.starredView") })).toBeInTheDocument();

    const calls = await vi.waitFor(() => {
      const found = messagesCalls(fetchMock);
      expect(found.some((url) => url.includes("hasKeyword=%24flagged"))).toBe(true);
      return found;
    });

    const flaggedCall = calls.find((url) => url.includes("hasKeyword=%24flagged"));
    expect(flaggedCall).not.toContain("mailboxId=");
  });

  it("excludes the archive mailbox from the starred view query", async () => {
    const { fetchMock } = renderAt("/?starred=1");

    await screen.findAllByText(i18n.t("mail.folders.inbox"));

    const flaggedCall = await vi.waitFor(() => {
      const found = messagesCalls(fetchMock).find(
        (url) => url.includes("hasKeyword=%24flagged") && url.includes("excludeMailboxId="),
      );
      expect(found).toBeDefined();
      return found;
    });

    expect(flaggedCall).toContain("excludeMailboxId=mb-archive");
  });

  it("marks the starred entry as current and does not highlight any mailbox", async () => {
    renderAt("/?starred=1");

    await screen.findAllByText(i18n.t("mail.folders.inbox"));
    const starredEntries = await screen.findAllByText(i18n.t("mail.starredView"));
    const starredButton = starredEntries
      .map((el) => el.closest("button"))
      .find((button): button is HTMLButtonElement => button !== null);
    expect(starredButton).toHaveAttribute("aria-current", "true");

    const inboxEntry = screen.getAllByText(i18n.t("mail.folders.inbox"))[0];
    expect(inboxEntry!.closest("button")).not.toHaveAttribute("aria-current");
  });
});
