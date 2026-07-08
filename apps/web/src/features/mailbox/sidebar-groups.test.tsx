import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../app/i18n";
import { Sidebar } from "./Sidebar";

const mailboxes = [
  {
    id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox",
    sortOrder: 0, unreadEmails: 0, totalEmails: 0,
  },
];

const groups = [
  { id: "i2", name: "Sales", email: "sales@noxvytop.com" },
  { id: "i3", name: "Support", email: "support@noxvytop.com" },
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

  it("calls onSelectGroup with the clicked address", () => {
    let selected: string | null = null;
    renderSidebar({ groups, onSelectGroup: (address) => { selected = address; } });

    fireEvent.click(screen.getByText("sales@noxvytop.com"));

    expect(selected).toBe("sales@noxvytop.com");
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
