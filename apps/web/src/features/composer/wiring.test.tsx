import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import "../../app/i18n";
import i18n from "../../app/i18n";
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
    id: "mb1", name: "Inbox", parentId: null, role: "inbox",
    sortOrder: 0, unreadEmails: 0, totalEmails: 1,
  },
];

const identities = [{ id: "id1", name: "Alice", email: "alice@example.com" }];

const thread = {
  id: "t1",
  emails: [
    {
      id: "e1",
      threadId: "t1",
      mailboxIds: ["mb1"],
      from: [{ name: null, email: "a@x.com" }],
      to: [{ name: "Alice", email: "alice@example.com" }],
      subject: "Hello",
      receivedAt: "2026-07-01T10:00:00.000Z",
      preview: "preview",
      keywords: {},
      hasAttachment: true,
      size: 100,
      cc: [],
      replyTo: [],
      bodyHtml: "<p>Hi</p>",
      bodyText: null,
      attachments: [{ blobId: "b1", name: "doc.pdf", type: "application/pdf", size: 2048 }],
    },
  ],
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return new Response(JSON.stringify(user));
      if (url.includes("/api/mail/mailboxes")) return new Response(JSON.stringify(mailboxes));
      if (url.includes("/api/mail/identities")) return new Response(JSON.stringify(identities));
      if (url.includes("/api/mail/signatures")) return new Response(JSON.stringify([]));
      if (url.includes("/api/mail/threads/")) return new Response(JSON.stringify(thread));
      if (url.includes("/api/mail/messages")) {
        return new Response(JSON.stringify({ total: 0, position: 0, emails: [] }));
      }
      return new Response(JSON.stringify({ status: "ok", checks: {} }));
    }),
  );
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("composer wiring", () => {
  it("opens the composer at compose=new and removes the param on Cancel", async () => {
    stubFetch();
    renderAt("/?mailbox=mb1&thread=t1&compose=new");

    expect(await screen.findByRole("dialog", { name: i18n.t("composer.title") })).toBeInTheDocument();

    const cancelButton = screen.getByRole("button", { name: i18n.t("composer.cancel") });
    fireEvent.click(cancelButton);

    expect(screen.queryByRole("dialog", { name: i18n.t("composer.title") })).not.toBeInTheDocument();
  });

  it("opens the composer at compose=reply:e1 with the from address chip in To", async () => {
    stubFetch();
    renderAt("/?mailbox=mb1&thread=t1&compose=reply:e1");

    const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.title") });
    expect(within(dialog).getByText("a@x.com")).toBeInTheDocument();
  });

  it("opens the composer at compose=forward:e1 with Fwd subject, no recipients and the original attachment", async () => {
    stubFetch();
    renderAt("/?mailbox=mb1&thread=t1&compose=forward:e1");

    const dialog = await screen.findByRole("dialog", { name: i18n.t("composer.title") });
    const subject = within(dialog).getByLabelText(i18n.t("composer.subject"));
    expect((subject as HTMLInputElement).value).toMatch(/^Fwd: /);
    expect(within(dialog).getByText(/doc\.pdf/)).toBeInTheDocument();
    expect(within(dialog).queryByText("a@x.com")).not.toBeInTheDocument();
  });
});
