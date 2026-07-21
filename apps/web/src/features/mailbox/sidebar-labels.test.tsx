import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    // Rendered as "Diseño" (its spec display name), not the stored slug
    // "diseno" — see the labelDisplayName override tests below.
    expect(within(region).getByText("Diseño")).toBeInTheDocument();
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
    expect(buttons.indexOf("Diseño")).toBeLessThan(buttons.indexOf("important")!);
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

  // Fresh-review MAJOR: canonical "diseño" used to be stored/filtered
  // accented, so clicking it sent hasKeyword=diseño while real mail is
  // tagged with the unaccented JMAP slug "diseno" — a dead filter that
  // always matched zero messages. The displayed text is the accented
  // "Diseño", but the value handed to onSelectLabel (and from there, the
  // hasKeyword query param) must be the real slug "diseno".
  it("clicking the canonical 'Diseño' chip filters by its JMAP slug 'diseno', not the accented display text", () => {
    let selected: string | null = null;
    renderSidebar({ labels: [], onSelectLabel: (label) => { selected = label; } });

    fireEvent.click(screen.getByText("Diseño"));

    expect(selected).toBe("diseno");
  });

  it("dedupes a real 'diseno'-tagged label into the single canonical chip instead of showing a duplicate", () => {
    renderSidebar({ labels: ["diseno"] });

    const region = screen.getByRole("navigation", { name: i18n.t("mail.labels") });
    expect(within(region).getAllByText("Diseño")).toHaveLength(1);
    expect(within(region).queryByText("diseno")).not.toBeInTheDocument();
  });

  it("renders a color dot matching the deterministic labelColor", () => {
    renderSidebar({ labels: ["important"] });

    const row = screen.getByText("important").closest("button")!;
    const dot = row.querySelector("span[aria-hidden='true']");
    expect(dot).toHaveStyle({ background: labelColor("important") });
  });
});

describe("sidebar compose button (CLARO-10: honest disabled state without identities)", () => {
  it("is enabled by default (composeDisabled defaults to false)", () => {
    renderSidebar();

    const composeButton = screen.getByRole("button", { name: i18n.t("composer.title") });
    expect(composeButton).not.toBeDisabled();
  });

  it("is disabled with an explanatory title when composeDisabled is true", () => {
    renderSidebar({ composeDisabled: true });

    const composeButton = screen.getByRole("button", { name: i18n.t("composer.title") });
    expect(composeButton).toBeDisabled();
    expect(composeButton).toHaveAttribute("title", i18n.t("composer.noIdentitiesHint"));
  });

  it("does not call onCompose when clicked while disabled", () => {
    const onCompose = vi.fn();
    renderSidebar({ composeDisabled: true, onCompose });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("composer.title") }));

    expect(onCompose).not.toHaveBeenCalled();
  });
});
