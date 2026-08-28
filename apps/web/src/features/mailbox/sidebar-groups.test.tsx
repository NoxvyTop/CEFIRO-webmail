import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { Sidebar } from "./Sidebar";
import type { GroupEntry } from "./groups";

const mailboxes = [
  {
    id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox",
    sortOrder: 0, unreadEmails: 0, totalEmails: 0,
  },
];

// #340: a group row is now one entry that may carry a shared account (the
// group's own mailbox), a personal-inbox filter address, or both.
const groups: GroupEntry[] = [
  { key: "sales@noxvytop.com", label: "sales@noxvytop.com", address: "sales@noxvytop.com" },
  { key: "support@noxvytop.com", label: "support@noxvytop.com", address: "support@noxvytop.com" },
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

describe("sidebar groups zone", () => {
  it("lists derived group addresses under the groups region", async () => {
    renderSidebar({ groups });

    const region = screen.getByRole("navigation", { name: "Grupos" });
    expect(region).toBeInTheDocument();
    expect(await screen.findByText("sales@noxvytop.com")).toBeInTheDocument();
    expect(await screen.findByText("support@noxvytop.com")).toBeInTheDocument();
  });

  it("calls onSelectGroup with the clicked entry", () => {
    let selected: GroupEntry | null = null;
    renderSidebar({ groups, onSelectGroup: (entry) => { selected = entry; } });

    fireEvent.click(screen.getByText("sales@noxvytop.com"));

    expect(selected).toEqual(groups[0]);
  });

  it("marks the selected group with aria-current", () => {
    renderSidebar({ groups, selectedGroup: "support@noxvytop.com" });

    const supportButton = screen.getByText("support@noxvytop.com").closest("button");
    const salesButton = screen.getByText("sales@noxvytop.com").closest("button");

    expect(supportButton).toHaveAttribute("aria-current", "true");
    expect(salesButton).not.toHaveAttribute("aria-current");
  });

  it("renders no groups region when there are no groups", () => {
    renderSidebar({ groups: [] });

    expect(screen.queryByRole("navigation", { name: "Grupos" })).not.toBeInTheDocument();
  });
});

// #340: the group used to appear twice under the same name — once under GRUPOS
// (the personal inbox filtered by recipient, which reads "0 correos" when no
// copy ever landed there) and once on the shared-mailboxes page. One row per
// group now, and it carries the unread count of the group's own inbox.
describe("sidebar groups zone — shared mailboxes (#340)", () => {
  const merged: GroupEntry[] = [
    {
      key: "acc-sales",
      label: "sales@noxvytop.com",
      address: "sales@noxvytop.com",
      accountId: "acc-sales",
      unread: 3,
    },
  ];

  it("shows one row per group, not one per view of it", () => {
    renderSidebar({ groups: merged });

    expect(screen.getAllByText("sales@noxvytop.com")).toHaveLength(1);
  });

  it("shows the shared inbox unread count on the group row", () => {
    renderSidebar({ groups: merged });

    const row = screen.getByText("sales@noxvytop.com").closest("button") as HTMLElement;
    expect(row).toHaveTextContent("3");
    expect(row).toHaveTextContent(i18n.t("mail.unread", { count: 3 }));
  });

  it("shows no counter when the group's mailbox has nothing unread", () => {
    renderSidebar({ groups: [{ ...merged[0]!, unread: 0 }] });

    const row = screen.getByText("sales@noxvytop.com").closest("button") as HTMLElement;
    expect(row).not.toHaveTextContent(i18n.t("mail.unread", { count: 0 }));
  });

  it("marks the row current while its shared account is the active one", () => {
    renderSidebar({ groups: merged, selectedAccountId: "acc-sales" });

    expect(screen.getByText("sales@noxvytop.com").closest("button")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("hands the whole entry to the parent so it can open the shared account", () => {
    const onSelectGroup = vi.fn();
    renderSidebar({ groups: merged, onSelectGroup });

    fireEvent.click(screen.getByText("sales@noxvytop.com"));

    expect(onSelectGroup).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-sales" }));
  });
});
