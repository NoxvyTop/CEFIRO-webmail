import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

  // CLARO-08/OSCURO-07: a fresh mailbox with no user keywords must still show
  // the product's 4-label taxonomy — the rail never disappears.
  it("always renders the labels region with the 4 canonical labels, even with no real labels", () => {
    renderSidebar({ labels: [] });

    const region = screen.getByRole("navigation", { name: i18n.t("mail.labels") });
    expect(region).toBeInTheDocument();
    expect(within(region).getByText("urgente")).toBeInTheDocument();
    expect(within(region).getByText("producto")).toBeInTheDocument();
    expect(within(region).getByText("diseño")).toBeInTheDocument();
    expect(within(region).getByText("finanzas")).toBeInTheDocument();
  });

  it("merges real labels after the canonical ones, deduping case-insensitively", () => {
    renderSidebar({ labels: ["Urgente", "important"] });

    const region = screen.getByRole("navigation", { name: i18n.t("mail.labels") });
    const buttons = within(region).getAllByRole("button").map((button) => button.textContent);

    // Only one "urgente" entry — the real "Urgente" label collapses into the
    // canonical one instead of appearing twice.
    expect(buttons.filter((text) => text?.toLowerCase() === "urgente")).toHaveLength(1);
    expect(buttons).toContain("important");
    // Canonical labels keep spec order ahead of the extra real label.
    expect(buttons.indexOf("diseño")).toBeLessThan(buttons.indexOf("important")!);
  });

  it("display-cases label text visually via CSS without changing the underlying value used for selection", () => {
    renderSidebar({ labels: [] });

    const urgenteButton = screen.getByText("urgente").closest("button")!;
    expect(urgenteButton.querySelector("span.capitalize")).toBeInTheDocument();
  });

  it("clicking a canonical label with zero matching mails still calls onSelectLabel", () => {
    let selected: string | null = null;
    renderSidebar({ labels: [], onSelectLabel: (label) => { selected = label; } });

    fireEvent.click(screen.getByText("finanzas"));

    expect(selected).toBe("finanzas");
  });

  it("renders a color dot matching the deterministic labelColor", () => {
    renderSidebar({ labels: ["important"] });

    const row = screen.getByText("important").closest("button")!;
    const dot = row.querySelector("span[aria-hidden='true']");
    expect(dot).toHaveStyle({ background: labelColor("important") });
  });
});
