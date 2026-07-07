import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { FilterRuleInput, Mailbox } from "@webmail/shared";
import { FilterRuleForm } from "./FilterRuleForm";

const mailboxes: Mailbox[] = [
  { id: "m1", name: "Inbox", parentId: null, role: "inbox", sortOrder: 0, unreadEmails: 0, totalEmails: 0 },
  { id: "m2", name: "Clients", parentId: null, role: null, sortOrder: 1, unreadEmails: 0, totalEmails: 0 },
  { id: "m3", name: "Acme", parentId: "m2", role: null, sortOrder: 2, unreadEmails: 0, totalEmails: 0 },
];

const emptyRule: FilterRuleInput = {
  name: "",
  matchType: "all",
  conditions: [{ field: "from", op: "contains", value: "" }],
  actions: [{ type: "seen" }],
  enabled: true,
};

function renderForm(overrides?: { initial?: FilterRuleInput; onSubmit?: (input: FilterRuleInput) => void }) {
  const onSubmit = overrides?.onSubmit ?? vi.fn();
  render(
    <FilterRuleForm
      initial={overrides?.initial ?? emptyRule}
      mailboxes={mailboxes}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  );
  return onSubmit;
}

describe("FilterRuleForm", () => {
  it("disables save until name and condition value are filled", () => {
    renderForm();
    const save = screen.getByRole("button", { name: i18n.t("settings.save") });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText(i18n.t("filters.name")), {
      target: { value: "invoices" },
    });
    fireEvent.change(screen.getByLabelText(`${i18n.t("filters.value")} 1`), {
      target: { value: "billing@" },
    });
    expect(save).toBeEnabled();
  });

  it("submits the built rule input", () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });

    fireEvent.change(screen.getByLabelText(i18n.t("filters.name")), {
      target: { value: "invoices" },
    });
    fireEvent.change(screen.getByLabelText(`${i18n.t("filters.value")} 1`), {
      target: { value: "billing@" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "invoices",
      matchType: "all",
      conditions: [{ field: "from", op: "contains", value: "billing@" }],
      actions: [{ type: "seen" }],
      enabled: true,
    });
  });

  it("adds and removes conditions up to the limit", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("filters.addCondition") }));
    expect(screen.getAllByLabelText(new RegExp(i18n.t("filters.value")))).toHaveLength(2);

    const removeButtons = screen.getAllByRole("button", { name: i18n.t("filters.remove") });
    fireEvent.click(removeButtons[0]!);
    expect(screen.getAllByLabelText(new RegExp(i18n.t("filters.value")))).toHaveLength(1);
  });

  it("shows the folder dropdown with nested paths for a move action", () => {
    renderForm({
      initial: { ...emptyRule, actions: [{ type: "fileinto", folder: "Clients/Acme" }] },
    });
    const folderSelect = screen.getByLabelText(`${i18n.t("filters.folder")} 1`);
    expect(folderSelect).toHaveValue("Clients/Acme");
    expect(screen.getByRole("option", { name: "Clients/Acme" })).toBeInTheDocument();
  });

  it("strips invalid characters from the flag keyword", () => {
    renderForm({
      initial: { ...emptyRule, actions: [{ type: "flag", keyword: "" }] },
    });
    const keywordInput = screen.getByLabelText(`${i18n.t("filters.keyword")} 1`);
    fireEvent.change(keywordInput, { target: { value: 'Imp"ort ant!' } });
    expect(keywordInput).toHaveValue("Important");
  });

  it("changing the action type resets its parameters", () => {
    renderForm();
    const actionSelect = screen.getByLabelText(`${i18n.t("filters.action")} 1`);
    fireEvent.change(actionSelect, { target: { value: "fileinto" } });
    expect(screen.getByLabelText(`${i18n.t("filters.folder")} 1`)).toHaveValue("Inbox");
  });
});
