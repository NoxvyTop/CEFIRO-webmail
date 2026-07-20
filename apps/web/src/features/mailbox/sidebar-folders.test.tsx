import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Mailbox } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { Sidebar } from "./Sidebar";

// Deliberately out of the fixed spec order and with the server's own
// sortOrder scrambled, to prove the client re-orders by role rather than
// trusting the server's order (docs/design/cefiro/README.md: Recibidos,
// Destacados, Enviados, Archivados; secondary folders grouped after).
const mailboxes: Mailbox[] = [
  { id: "mb-drafts", name: "Drafts", parentId: null, role: "drafts", sortOrder: 0, unreadEmails: 4, totalEmails: 4 },
  { id: "mb-archive", name: "Archive", parentId: null, role: "archive", sortOrder: 1, unreadEmails: 2, totalEmails: 9 },
  { id: "mb-trash", name: "Trash", parentId: null, role: "trash", sortOrder: 2, unreadEmails: 0, totalEmails: 1 },
  { id: "mb-inbox", name: "INBOX", parentId: null, role: "inbox", sortOrder: 3, unreadEmails: 5, totalEmails: 20 },
  { id: "mb-sent", name: "Sent", parentId: null, role: "sent", sortOrder: 4, unreadEmails: 0, totalEmails: 6 },
  { id: "mb-junk", name: "Junk", parentId: null, role: "junk", sortOrder: 5, unreadEmails: 3, totalEmails: 3 },
];

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Sidebar
        mailboxes={mailboxes}
        selectedMailboxId="mb-inbox"
        onSelectMailbox={() => {}}
        groups={[]}
        selectedGroup={null}
        onSelectGroup={() => {}}
        onCompose={() => {}}
        starredSelected={false}
        onSelectStarred={() => {}}
        labels={[]}
        selectedLabel={null}
        onSelectLabel={() => {}}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe("sidebar folder localization, order and unread badge", () => {
  it("localizes each folder name by its JMAP role", () => {
    renderSidebar();

    expect(screen.getByText(i18n.t("mail.folders.inbox"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("mail.folders.sent"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("mail.folders.archive"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("mail.folders.trash"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("mail.folders.junk"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("mail.folders.drafts"))).toBeInTheDocument();
  });

  it("orders Recibidos, Destacados, Enviados, Archivados first, then secondary folders", () => {
    renderSidebar();

    const rows = screen.getAllByRole("button").map((button) => button.textContent ?? "");
    // Drop the leading "Redactar" compose button, which is not a nav row.
    const navRows = rows.filter((text) => !text.includes(i18n.t("composer.title")));

    const order = [
      i18n.t("mail.folders.inbox"),
      i18n.t("mail.starredView"),
      i18n.t("mail.folders.sent"),
      i18n.t("mail.folders.archive"),
    ];
    const indices = order.map((label) => navRows.findIndex((text) => text.includes(label)));

    expect(indices.every((index) => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));

    const secondaryStart = Math.max(...indices);
    const trashIndex = navRows.findIndex((text) => text.includes(i18n.t("mail.folders.trash")));
    const junkIndex = navRows.findIndex((text) => text.includes(i18n.t("mail.folders.junk")));
    const draftsIndex = navRows.findIndex((text) => text.includes(i18n.t("mail.folders.drafts")));

    expect(trashIndex).toBeGreaterThan(secondaryStart);
    expect(junkIndex).toBeGreaterThan(secondaryStart);
    expect(draftsIndex).toBeGreaterThan(secondaryStart);
  });

  it("shows the unread accent badge only on the inbox row, even though other folders have unread mail", () => {
    renderSidebar();

    const inboxRow = screen.getByText(i18n.t("mail.folders.inbox")).closest("button")!;
    expect(inboxRow.querySelector("[aria-label]")).toBeInTheDocument();
    expect(inboxRow).toHaveTextContent("5");

    for (const role of ["archive", "drafts", "junk"] as const) {
      const row = screen.getByText(i18n.t(`mail.folders.${role}`)).closest("button")!;
      expect(row.querySelector("[aria-label]")).not.toBeInTheDocument();
    }
  });
});
