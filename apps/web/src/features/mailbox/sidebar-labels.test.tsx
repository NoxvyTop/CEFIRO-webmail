import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { labelColor } from "../../app/ui/labels";
import { Sidebar } from "./Sidebar";

const mailboxes = [
  {
    id: "mb-inbox", name: "Inbox", parentId: null, role: "inbox",
    sortOrder: 0, unreadEmails: 0, totalEmails: 0,
  },
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

describe("sidebar labels zone", () => {
  it("lists labels under the labels region with a color dot", async () => {
    renderSidebar({ labels: ["important", "urgent"] });

    const region = screen.getByRole("navigation", { name: i18n.t("mail.labels") });
    expect(region).toBeInTheDocument();
    expect(await screen.findByText("important")).toBeInTheDocument();
    expect(await screen.findByText("urgent")).toBeInTheDocument();
  });

  it("calls onSelectLabel with the clicked label", () => {
    let selected: string | null = null;
    renderSidebar({ labels: ["important"], onSelectLabel: (label) => { selected = label; } });

    fireEvent.click(screen.getByText("important"));

    expect(selected).toBe("important");
  });

  it("marks the selected label with aria-current", () => {
    renderSidebar({ labels: ["important", "urgent"], selectedLabel: "urgent" });

    const urgentButton = screen.getByText("urgent").closest("button");
    const importantButton = screen.getByText("important").closest("button");

    expect(urgentButton).toHaveAttribute("aria-current", "true");
    expect(importantButton).not.toHaveAttribute("aria-current");
  });

  it("renders no labels region when there are no labels", () => {
    renderSidebar({ labels: [] });

    expect(screen.queryByRole("navigation", { name: i18n.t("mail.labels") })).not.toBeInTheDocument();
  });

  it("renders a color dot matching the deterministic labelColor", () => {
    renderSidebar({ labels: ["important"] });

    const row = screen.getByText("important").closest("button")!;
    const dot = row.querySelector("span[aria-hidden='true']");
    expect(dot).toHaveStyle({ background: labelColor("important") });
  });
});
