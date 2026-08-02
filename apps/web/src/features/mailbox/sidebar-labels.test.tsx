import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CustomLabel } from "@webmail/shared";
import "../../app/i18n";
import i18n from "../../app/i18n";
import { CUSTOM_LABEL_PALETTE, labelColor } from "../../app/ui/labels";
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

  // GH #102: a fresh mailbox with no custom labels and no real keywords must
  // show ZERO label rows — there is no more seeded/scaffolded taxonomy.
  it("renders no label rows for a fresh user: no customLabels, no real labels", () => {
    renderSidebar({ labels: [], customLabels: [] });

    const region = screen.getByRole("navigation", { name: i18n.t("mail.labels") });
    expect(region).toBeInTheDocument();
    // The only button left is the "Nueva etiqueta" affordance — zero label rows.
    const buttons = within(region).getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual([i18n.t("mail.newLabel")]);
    // The former-canonical names must not appear anywhere on their own.
    expect(within(region).queryByText("urgente")).not.toBeInTheDocument();
    expect(within(region).queryByText("producto")).not.toBeInTheDocument();
    expect(within(region).queryByText("Diseño")).not.toBeInTheDocument();
    expect(within(region).queryByText("finanzas")).not.toBeInTheDocument();
  });

  it("merges real labels after the user's custom ones, deduping case-insensitively", () => {
    const ventas: CustomLabel = { slug: "ventas", name: "Ventas", color: "#9B6BDB" };
    renderSidebar({ labels: ["Ventas", "important"], customLabels: [ventas] });

    const region = screen.getByRole("navigation", { name: i18n.t("mail.labels") });
    const buttons = within(region).getAllByRole("button").map((button) => button.textContent);

    // Only one "Ventas" entry — the real "Ventas" keyword collapses into the
    // custom label instead of appearing twice.
    expect(buttons.filter((text) => text?.toLowerCase() === "ventas")).toHaveLength(1);
    expect(buttons).toContain("important");
    // Custom labels come ahead of the extra real label.
    expect(buttons.indexOf("Ventas")).toBeLessThan(buttons.indexOf("important")!);
  });

  it("display-cases label text visually via CSS without changing the underlying value used for selection", () => {
    renderSidebar({ labels: ["important"] });

    const importantButton = screen.getByText("important").closest("button")!;
    expect(importantButton.querySelector("span.capitalize")).toBeInTheDocument();
  });

  it("clicking a real discovered label with a fresh customLabels list still calls onSelectLabel", () => {
    let selected: string | null = null;
    renderSidebar({ labels: ["important"], onSelectLabel: (label) => { selected = label; } });

    fireEvent.click(screen.getByText("important"));

    expect(selected).toBe("important");
  });

  // Fresh-review MAJOR (still applies with a real discovered "diseno"
  // keyword, independent of the removed canonical scaffolding): the
  // LABEL_DISPLAY_OVERRIDES machinery renders it as accented "Diseño", but
  // the value handed to onSelectLabel (and from there, the hasKeyword query
  // param) must stay the real unaccented JMAP slug "diseno", or the filter
  // matches zero messages.
  it("clicking a real 'diseno' label filters by its JMAP slug, showing the accented 'Diseño' display text", () => {
    let selected: string | null = null;
    renderSidebar({ labels: ["diseno"], onSelectLabel: (label) => { selected = label; } });

    const region = screen.getByRole("navigation", { name: i18n.t("mail.labels") });
    // Rendered as "Diseño" (its spec display name), not the stored slug —
    // and only once, since there's a single "diseno" source now.
    expect(within(region).getAllByText("Diseño")).toHaveLength(1);
    expect(within(region).queryByText("diseno")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Diseño"));

    expect(selected).toBe("diseno");
  });

  it("renders a color dot matching the deterministic labelColor", () => {
    renderSidebar({ labels: ["important"] });

    const row = screen.getByText("important").closest("button")!;
    const dot = row.querySelector("span[aria-hidden='true']");
    expect(dot).toHaveStyle({ background: labelColor("important") });
  });
});

describe("sidebar custom labels (Gmail-model: create/list/delete)", () => {
  const ventas: CustomLabel = { slug: "ventas-q3", name: "Ventas Q3", color: "#9B6BDB" };

  it("lists custom labels before real discovered labels, with their stored name and color", () => {
    renderSidebar({ labels: ["important"], customLabels: [ventas] });

    const region = screen.getByRole("navigation", { name: i18n.t("mail.labels") });
    const row = within(region).getByText("Ventas Q3").closest("button")!;
    const dot = row.querySelector("span[aria-hidden='true']");
    expect(dot).toHaveStyle({ background: labelColor("ventas-q3", [ventas]) });

    const buttons = within(region).getAllByRole("button").map((button) => button.textContent);
    expect(buttons.indexOf("Ventas Q3")).toBeLessThan(buttons.indexOf("important"));
  });

  // GH #109: "Nueva etiqueta" now opens a CENTERED MODAL (role="dialog"),
  // not an inline form appended under the labels list.
  it("shows a 'Nueva etiqueta' affordance that opens a centered dialog, not an inline form", () => {
    renderSidebar();

    expect(screen.queryByRole("dialog", { name: i18n.t("mail.newLabel") })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.newLabel") }));

    const dialog = screen.getByRole("dialog", { name: i18n.t("mail.newLabel") });
    expect(dialog).toBeInTheDocument();
    // GH #253: the focus trap arrived with #158; the matching promise to
    // assistive tech that the rest of the page is inert did not.
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByPlaceholderText(i18n.t("mail.labelNamePlaceholder"))).toBeInTheDocument();
    for (const hex of CUSTOM_LABEL_PALETTE) {
      expect(
        within(dialog).getByRole("button", { name: i18n.t("mail.chooseLabelColor", { hex }) }),
      ).toBeInTheDocument();
    }
    expect(within(dialog).getByRole("button", { name: i18n.t("mail.createLabel") })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: i18n.t("mail.cancelNewLabel") })).toBeInTheDocument();
  });

  it("creating a label slugifies the name, uses the picked color, and calls onCreateLabel", () => {
    const onCreateLabel = vi.fn();
    renderSidebar({ onCreateLabel });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.newLabel") }));
    fireEvent.change(screen.getByPlaceholderText(i18n.t("mail.labelNamePlaceholder")), {
      target: { value: "Ventas Q3" },
    });
    const pickedColor = CUSTOM_LABEL_PALETTE[1]!;
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.chooseLabelColor", { hex: pickedColor }) }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.createLabel") }));

    expect(onCreateLabel).toHaveBeenCalledWith({ slug: "ventas-q3", name: "Ventas Q3", color: pickedColor });
    // Form closes after a successful submit.
    expect(screen.queryByPlaceholderText(i18n.t("mail.labelNamePlaceholder"))).not.toBeInTheDocument();
  });

  it("submitting an empty name shows a validation error and does not call onCreateLabel", () => {
    const onCreateLabel = vi.fn();
    renderSidebar({ onCreateLabel });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.newLabel") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.createLabel") }));

    expect(screen.getByText(i18n.t("mail.labelNameRequired"))).toBeInTheDocument();
    expect(onCreateLabel).not.toHaveBeenCalled();
  });

  // GH #83: the 4 former-canonical names are no longer reserved — a user
  // with no existing "Urgente" label must be able to create their own.
  it("creating a label named after a former-canonical name succeeds (GH #83, not reserved)", () => {
    const onCreateLabel = vi.fn();
    renderSidebar({ onCreateLabel });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.newLabel") }));
    fireEvent.change(screen.getByPlaceholderText(i18n.t("mail.labelNamePlaceholder")), {
      target: { value: "Urgente" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.createLabel") }));

    expect(onCreateLabel).toHaveBeenCalledWith({ slug: "urgente", name: "Urgente", color: CUSTOM_LABEL_PALETTE[0] });
    expect(screen.queryByText(i18n.t("mail.labelNameDuplicate"))).not.toBeInTheDocument();
  });

  it("submitting a name that collides with an existing custom label (case-insensitive) shows a duplicate error", () => {
    const onCreateLabel = vi.fn();
    renderSidebar({ customLabels: [ventas], onCreateLabel });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.newLabel") }));
    fireEvent.change(screen.getByPlaceholderText(i18n.t("mail.labelNamePlaceholder")), {
      target: { value: "ventas q3" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.createLabel") }));

    expect(screen.getByText(i18n.t("mail.labelNameDuplicate"))).toBeInTheDocument();
    expect(onCreateLabel).not.toHaveBeenCalled();
  });

  it("clicking Cancelar closes the dialog without calling onCreateLabel", () => {
    const onCreateLabel = vi.fn();
    renderSidebar({ onCreateLabel });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.newLabel") }));
    fireEvent.change(screen.getByPlaceholderText(i18n.t("mail.labelNamePlaceholder")), {
      target: { value: "Ventas" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.cancelNewLabel") }));

    expect(screen.queryByRole("dialog", { name: i18n.t("mail.newLabel") })).not.toBeInTheDocument();
    expect(onCreateLabel).not.toHaveBeenCalled();
  });

  it("pressing Escape closes the dialog without calling onCreateLabel", () => {
    const onCreateLabel = vi.fn();
    renderSidebar({ onCreateLabel });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.newLabel") }));
    expect(screen.getByRole("dialog", { name: i18n.t("mail.newLabel") })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: i18n.t("mail.newLabel") })).not.toBeInTheDocument();
    expect(onCreateLabel).not.toHaveBeenCalled();
  });

  it("clicking the backdrop closes the dialog without calling onCreateLabel", () => {
    const onCreateLabel = vi.fn();
    renderSidebar({ onCreateLabel });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.newLabel") }));
    const dialog = screen.getByRole("dialog", { name: i18n.t("mail.newLabel") });

    fireEvent.click(dialog);

    expect(screen.queryByRole("dialog", { name: i18n.t("mail.newLabel") })).not.toBeInTheDocument();
    expect(onCreateLabel).not.toHaveBeenCalled();
  });

  it("the name input is autofocused when the dialog opens", () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.newLabel") }));

    expect(screen.getByPlaceholderText(i18n.t("mail.labelNamePlaceholder"))).toHaveFocus();
  });

  it("shows a delete affordance on a custom label row", () => {
    renderSidebar({ customLabels: [ventas] });

    expect(
      screen.getByRole("button", { name: i18n.t("mail.deleteLabel", { name: "Ventas Q3" }) }),
    ).toBeInTheDocument();
  });

  it("does not show a delete affordance on a real, discovered label with no stored custom-label definition", () => {
    renderSidebar({ labels: ["important"] });

    const region = screen.getByRole("navigation", { name: i18n.t("mail.labels") });
    const importantRow = within(region).getByText("important").closest("li")!;
    expect(within(importantRow).getAllByRole("button")).toHaveLength(1);
  });

  // Review finding #1: a user-created label named "Urgente" must render with
  // its OWN picked color, not silently fall back to the fixed brand red —
  // GH #83 made the 4 former-canonical names ordinary, user-owned labels.
  it("a custom label named 'Urgente' renders with its own picked-color dot, not the fixed brand red", () => {
    const urgente: CustomLabel = { slug: "urgente", name: "Urgente", color: CUSTOM_LABEL_PALETTE[2]! };
    renderSidebar({ customLabels: [urgente] });

    const region = screen.getByRole("navigation", { name: i18n.t("mail.labels") });
    const row = within(region).getByText("Urgente").closest("button")!;
    const dot = row.querySelector("span[aria-hidden='true']");

    expect(dot).toHaveStyle({ background: labelColor("urgente", [urgente]) });
    expect(dot).not.toHaveStyle({ background: "#F26565" });
  });
});

describe("sidebar label delete protection (GH #103: no accidental single-click delete)", () => {
  const ventas: CustomLabel = { slug: "ventas-q3", name: "Ventas Q3", color: "#9B6BDB" };

  function getDeleteButton() {
    return screen.getByRole("button", { name: i18n.t("mail.deleteLabel", { name: "Ventas Q3" }) });
  }

  it("the delete button is hidden by default (opacity-0), not removed — it stays focusable", () => {
    renderSidebar({ customLabels: [ventas] });

    const deleteButton = getDeleteButton();
    expect(deleteButton.className).toMatch(/(?:^|\s)opacity-0(?:\s|$)/);
    expect(deleteButton).not.toHaveAttribute("disabled");
    expect(deleteButton).not.toHaveAttribute("hidden");
  });

  it("the delete button carries hover- and focus-reveal classes, not hover-only (keyboard users can reach it)", () => {
    renderSidebar({ customLabels: [ventas] });

    const deleteButton = getDeleteButton();
    expect(deleteButton.className).toMatch(/group-hover:opacity-100/);
    expect(deleteButton.className).toMatch(/group-focus-within:opacity-100|focus-visible:opacity-100/);
  });

  it("the delete button is reachable via keyboard focus without hovering first", () => {
    renderSidebar({ customLabels: [ventas] });

    const deleteButton = getDeleteButton();
    deleteButton.focus();

    expect(deleteButton).toHaveFocus();
  });

  it("clicking delete does not call onDeleteLabel immediately — it shows an inline confirmation instead", () => {
    const onDeleteLabel = vi.fn();
    renderSidebar({ customLabels: [ventas], onDeleteLabel });

    fireEvent.click(getDeleteButton());

    expect(onDeleteLabel).not.toHaveBeenCalled();
    expect(screen.getByText(i18n.t("mail.confirmDeleteLabel", { name: "Ventas Q3" }))).toBeInTheDocument();
  });

  // Review finding #2: without this, focus falls back to document.body when
  // the row swaps to the confirm prompt, stranding a keyboard user who
  // activated delete via Enter/Space. Cancelar (the safe action) is the
  // auto-focus target, not Confirmar — so a reflexive second Enter/Space
  // (e.g. muscle memory from the keypress that opened the prompt) cancels
  // instead of deleting.
  it("auto-focuses the Cancelar control when the confirm prompt mounts", () => {
    renderSidebar({ customLabels: [ventas] });

    fireEvent.click(getDeleteButton());

    expect(screen.getByRole("button", { name: i18n.t("mail.cancelNewLabel") })).toHaveFocus();
  });

  it("confirming the inline prompt calls onDeleteLabel with the label's slug", () => {
    const onDeleteLabel = vi.fn();
    renderSidebar({ customLabels: [ventas], onDeleteLabel });

    fireEvent.click(getDeleteButton());
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.confirmDelete") }));

    expect(onDeleteLabel).toHaveBeenCalledWith("ventas-q3");
  });

  it("cancelling the inline prompt restores the normal row without calling onDeleteLabel", () => {
    const onDeleteLabel = vi.fn();
    renderSidebar({ customLabels: [ventas], onDeleteLabel });

    fireEvent.click(getDeleteButton());
    fireEvent.click(screen.getByRole("button", { name: i18n.t("mail.cancelNewLabel") }));

    expect(onDeleteLabel).not.toHaveBeenCalled();
    expect(screen.queryByText(i18n.t("mail.confirmDeleteLabel", { name: "Ventas Q3" }))).not.toBeInTheDocument();
    expect(screen.getByText("Ventas Q3")).toBeInTheDocument();
    expect(getDeleteButton()).toBeInTheDocument();
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
