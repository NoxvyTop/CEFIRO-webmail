import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import "../../app/i18n";
import { routes } from "../../app/routes";

const user = {
  userId: "u1",
  email: "emp@noxvytop.com",
  displayName: "Emp",
  role: "employee",
  locale: "es",
};

const mailboxes = [
  {
    id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox",
    sortOrder: 0, unreadEmails: 3, totalEmails: 10,
  },
  {
    id: "mb-archive", name: "Archive", parentId: null, role: null,
    sortOrder: 1, unreadEmails: 0, totalEmails: 5,
  },
];

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/me")) return new Response(JSON.stringify(user));
      if (path.includes("/api/mail/mailboxes")) return new Response(JSON.stringify(mailboxes));
      if (path.includes("/api/mail/messages")) {
        return new Response(JSON.stringify({ total: 0, position: 0, emails: [] }));
      }
      return new Response(JSON.stringify({ status: "ok", checks: {} }));
    }),
  );
}

describe("mailbox sidebar", () => {
  it("selects the inbox by role by default and unread badge is visible", async () => {
    stubFetch();
    renderAt("/");

    const inbox = await screen.findByText("Inbox");
    expect(await screen.findByText("Archive")).toBeInTheDocument();
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(inbox.closest("[aria-current]")).toHaveAttribute("aria-current", "true");
  });

  it("selects the clicked mailbox via the URL", async () => {
    stubFetch();
    renderAt("/");

    await screen.findByText("Inbox");
    const archive = await screen.findByText("Archive");
    fireEvent.click(archive);

    expect(await screen.findByText("Archive")).toBeInTheDocument();
    expect(archive.closest("[aria-current]")).toHaveAttribute("aria-current", "true");
  });
});
