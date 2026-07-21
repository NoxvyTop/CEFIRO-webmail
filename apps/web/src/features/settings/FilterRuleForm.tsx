import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { FilterAction, FilterCondition, FilterRuleInput, Mailbox } from "@webmail/shared";

const MAX_ITEMS = 10;
const FIELD_OPTIONS = ["from", "to", "subject", "body"] as const;
const OP_OPTIONS = ["contains", "is"] as const;
const ACTION_OPTIONS = ["fileinto", "seen", "flag", "delete", "stop"] as const;

type Props = {
  initial: FilterRuleInput;
  mailboxes: Mailbox[];
  onSubmit: (input: FilterRuleInput) => void;
  onCancel: () => void;
};

function mailboxPaths(mailboxes: Mailbox[]): string[] {
  const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  return mailboxes.map((mailbox) => {
    const parts = [mailbox.name];
    const visited = new Set([mailbox.id]);
    let parent = mailbox.parentId ? byId.get(mailbox.parentId) : undefined;
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      parts.unshift(parent.name);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return parts.join("/");
  });
}

function defaultAction(type: FilterAction["type"], firstFolder: string): FilterAction {
  switch (type) {
    case "fileinto":
      return { type: "fileinto", folder: firstFolder };
    case "seen":
      return { type: "seen" };
    case "flag":
      return { type: "flag", keyword: "" };
    case "delete":
      return { type: "delete" };
    case "stop":
      return { type: "stop" };
  }
}

export function FilterRuleForm({ initial, mailboxes, onSubmit, onCancel }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [matchType, setMatchType] = useState<FilterRuleInput["matchType"]>(initial.matchType);
  const [conditions, setConditions] = useState<FilterCondition[]>(initial.conditions);
  const [actions, setActions] = useState<FilterAction[]>(initial.actions);
  const [enabled, setEnabled] = useState(initial.enabled);

  const folders = mailboxPaths(mailboxes);
  const firstFolder = folders[0] ?? "";

  const valid =
    name.trim().length > 0 &&
    conditions.length > 0 &&
    conditions.every((condition) => condition.value.trim().length > 0) &&
    actions.length > 0 &&
    actions.every((action) => {
      if (action.type === "flag") return action.keyword.trim().length > 0;
      if (action.type === "fileinto") return action.folder.length > 0;
      return true;
    });

  function updateCondition(index: number, patch: Partial<FilterCondition>) {
    setConditions(
      conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    onSubmit({ name, matchType, conditions, actions, enabled });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-md border border-line p-3">
      <label htmlFor="filter-name" className="flex flex-col gap-1 text-sm">
        {t("filters.name")}
        <input
          id="filter-name"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          className="h-11 rounded-input border border-line bg-soft px-3 text-ink outline-none focus:border-accent"
        />
      </label>

      <label htmlFor="filter-match" className="flex flex-col gap-1 text-sm">
        {t("filters.matchType")}
        <select
          id="filter-match"
          value={matchType}
          onChange={(event) => setMatchType(event.target.value as FilterRuleInput["matchType"])}
          className="self-start h-11 rounded-input border border-line bg-soft px-3 text-ink outline-none focus:border-accent"
        >
          <option value="all">{t("filters.matchAll")}</option>
          <option value="any">{t("filters.matchAny")}</option>
        </select>
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t("filters.conditions")}</legend>
        {conditions.map((condition, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`${t("filters.field")} ${index + 1}`}
              value={condition.field}
              onChange={(event) =>
                updateCondition(index, { field: event.target.value as FilterCondition["field"] })
              }
              className="h-11 rounded-input border border-line bg-soft px-3 text-sm text-ink outline-none focus:border-accent"
            >
              {FIELD_OPTIONS.map((field) => (
                <option key={field} value={field}>
                  {t(`filters.field_${field}`)}
                </option>
              ))}
            </select>
            <select
              aria-label={`${t("filters.op")} ${index + 1}`}
              value={condition.op}
              onChange={(event) =>
                updateCondition(index, { op: event.target.value as FilterCondition["op"] })
              }
              className="h-11 rounded-input border border-line bg-soft px-3 text-sm text-ink outline-none focus:border-accent"
            >
              {OP_OPTIONS.map((op) => (
                <option key={op} value={op}>
                  {t(`filters.op_${op}`)}
                </option>
              ))}
            </select>
            <input
              aria-label={`${t("filters.value")} ${index + 1}`}
              value={condition.value}
              maxLength={500}
              onChange={(event) => updateCondition(index, { value: event.target.value })}
              className="min-w-40 flex-1 h-11 rounded-input border border-line bg-soft px-3 text-sm text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={conditions.length === 1}
              onClick={() => setConditions(conditions.filter((_, i) => i !== index))}
              className="rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover disabled:opacity-50"
            >
              {t("filters.remove")}
            </button>
          </div>
        ))}
        {conditions.length < MAX_ITEMS && (
          <button
            type="button"
            onClick={() =>
              setConditions([...conditions, { field: "from", op: "contains", value: "" }])
            }
            className="self-start rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover"
          >
            {t("filters.addCondition")}
          </button>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t("filters.actions")}</legend>
        {actions.map((action, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`${t("filters.action")} ${index + 1}`}
              value={action.type}
              onChange={(event) =>
                setActions(
                  actions.map((item, i) =>
                    i === index
                      ? defaultAction(event.target.value as FilterAction["type"], firstFolder)
                      : item,
                  ),
                )
              }
              className="h-11 rounded-input border border-line bg-soft px-3 text-sm text-ink outline-none focus:border-accent"
            >
              {ACTION_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {t(`filters.action_${type}`)}
                </option>
              ))}
            </select>
            {action.type === "fileinto" && (
              <select
                aria-label={`${t("filters.folder")} ${index + 1}`}
                value={action.folder}
                onChange={(event) =>
                  setActions(
                    actions.map((item, i) =>
                      i === index ? { type: "fileinto", folder: event.target.value } : item,
                    ),
                  )
                }
                className="h-11 rounded-input border border-line bg-soft px-3 text-sm text-ink outline-none focus:border-accent"
              >
                {folders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder}
                  </option>
                ))}
              </select>
            )}
            {action.type === "flag" && (
              <input
                aria-label={`${t("filters.keyword")} ${index + 1}`}
                value={action.keyword}
                maxLength={64}
                onChange={(event) =>
                  setActions(
                    actions.map((item, i) =>
                      i === index
                        ? {
                            type: "flag",
                            keyword: event.target.value.replace(/[^A-Za-z0-9$_.-]/g, ""),
                          }
                        : item,
                    ),
                  )
                }
                className="h-11 rounded-input border border-line bg-soft px-3 text-sm text-ink outline-none focus:border-accent"
              />
            )}
            <button
              type="button"
              disabled={actions.length === 1}
              onClick={() => setActions(actions.filter((_, i) => i !== index))}
              className="rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover disabled:opacity-50"
            >
              {t("filters.remove")}
            </button>
          </div>
        ))}
        {actions.length < MAX_ITEMS && (
          <button
            type="button"
            onClick={() => setActions([...actions, { type: "seen" }])}
            className="self-start rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover"
          >
            {t("filters.addAction")}
          </button>
        )}
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("filters.enabled")}
      </label>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-[9px] border border-line-strong px-3 py-1 text-sm transition hover:border-accent hover:bg-hover">
          {t("composer.cancel")}
        </button>
        <button
          type="submit"
          disabled={!valid}
          className="rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98] disabled:opacity-50"
        >
          {t("settings.save")}
        </button>
      </div>
    </form>
  );
}
