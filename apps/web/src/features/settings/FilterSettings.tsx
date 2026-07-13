import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { FilterRule, FilterRuleInput } from "@webmail/shared";
import { MailApiError, fetchMailboxes } from "../mailbox/api";
import {
  createFilterRule,
  deleteFilterRule,
  fetchFilterRules,
  reorderFilterRules,
  syncFilters,
  updateFilterRule,
} from "./api";
import { settingsErrorKey } from "./errors";
import { FilterRuleForm } from "./FilterRuleForm";
import { ChevronDownIcon, ChevronUpIcon } from "../../app/ui/icons";

const FILTERS_QUERY_KEY = ["mail", "filters"] as const;

const EMPTY_RULE: FilterRuleInput = {
  name: "",
  matchType: "all",
  conditions: [{ field: "from", op: "contains", value: "" }],
  actions: [{ type: "seen" }],
  enabled: true,
};

function toInput(rule: FilterRule): FilterRuleInput {
  return {
    name: rule.name,
    matchType: rule.matchType,
    conditions: rule.conditions,
    actions: rule.actions,
    enabled: rule.enabled,
  };
}

function isSieveSyncError(error: unknown): boolean {
  return (
    error instanceof MailApiError &&
    (error.code === "sieve_sync_failed" || error.code === "sieve_invalid")
  );
}

export function FilterSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const filtersQuery = useQuery({ queryKey: FILTERS_QUERY_KEY, queryFn: fetchFilterRules });
  const mailboxesQuery = useQuery({ queryKey: ["mail", "mailboxes"], queryFn: fetchMailboxes });

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [reapplied, setReapplied] = useState(false);

  function invalidateFilters() {
    return queryClient.invalidateQueries({ queryKey: FILTERS_QUERY_KEY });
  }

  function resetForm() {
    setFormOpen(false);
    setEditingId(null);
  }

  function beginMutation() {
    setReapplied(false);
    setErrorKey(null);
  }

  function handleError(error: unknown) {
    setErrorKey(settingsErrorKey(error));
  }

  const createMutation = useMutation({
    mutationFn: (input: FilterRuleInput) => createFilterRule(input),
    onMutate: beginMutation,
    onSuccess: () => resetForm(),
    onError: (error) => {
      handleError(error);
      if (isSieveSyncError(error)) resetForm();
    },
    onSettled: () => invalidateFilters(),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: FilterRuleInput }) =>
      updateFilterRule(id, input),
    onMutate: beginMutation,
    onSuccess: () => resetForm(),
    onError: (error) => {
      handleError(error);
      if (isSieveSyncError(error)) resetForm();
    },
    onSettled: () => invalidateFilters(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFilterRule(id),
    onMutate: beginMutation,
    onError: handleError,
    onSettled: () => invalidateFilters(),
  });

  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => reorderFilterRules(ids),
    onMutate: beginMutation,
    onError: handleError,
    onSettled: () => invalidateFilters(),
  });

  const syncMutation = useMutation({
    mutationFn: () => syncFilters(),
    onSuccess: () => {
      setErrorKey(null);
      setReapplied(true);
    },
    onError: handleError,
  });

  const rules = filtersQuery.data ?? [];
  const editingRule = editingId ? rules.find((rule) => rule.id === editingId) : undefined;

  function move(index: number, delta: number) {
    const ids = rules.map((rule) => rule.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorderMutation.mutate(ids);
  }

  return (
    <div className="flex flex-col gap-4">
      {errorKey && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/40 bg-soft p-2 text-sm text-danger"
        >
          <span>{t(errorKey)}</span>
          {errorKey === "settings.errors.sieve_sync_failed" && (
            <button
              type="button"
              onClick={() => syncMutation.mutate()}
              className="rounded-md border border-danger/40 px-2 py-1 text-xs hover:bg-hover"
            >
              {t("filters.reapply")}
            </button>
          )}
        </div>
      )}
      {reapplied && !errorKey && (
        <p className="text-sm text-accent">{t("filters.reapplied")}</p>
      )}

      {rules.length === 0 && !filtersQuery.isLoading && (
        <p className="text-sm text-muted">{t("filters.empty")}</p>
      )}

      <ul className="flex flex-col gap-2">
        {rules.map((rule, index) => (
          <li
            key={rule.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-2 text-sm"
          >
            <div className="flex items-center gap-2">
              <span>{rule.name}</span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                aria-label={t("filters.moveUp")}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover disabled:opacity-50"
              >
                <ChevronUpIcon size={14} />
              </button>
              <button
                type="button"
                aria-label={t("filters.moveDown")}
                disabled={index === rules.length - 1}
                onClick={() => move(index, 1)}
                className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover disabled:opacity-50"
              >
                <ChevronDownIcon size={14} />
              </button>
              <button
                type="button"
                aria-pressed={rule.enabled}
                onClick={() =>
                  updateMutation.mutate({
                    id: rule.id,
                    input: { ...toInput(rule), enabled: !rule.enabled },
                  })
                }
                className={
                  rule.enabled
                    ? "rounded-md border border-accent/40 bg-sel px-2 py-1 text-xs text-accent"
                    : "rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-hover"
                }
              >
                {rule.enabled ? t("filters.enabled") : t("filters.disabled")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingId(rule.id);
                  setFormOpen(true);
                }}
                className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover"
              >
                {t("settings.edit")}
              </button>
              <button
                type="button"
                onClick={() => deleteMutation.mutate(rule.id)}
                className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover"
              >
                {t("settings.delete")}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {!formOpen && (
        <button
          type="button"
          onClick={() => {
            setEditingId(null);
            setFormOpen(true);
          }}
          className="self-start rounded-md border border-line px-3 py-1 text-sm hover:bg-hover"
        >
          {t("filters.newRule")}
        </button>
      )}

      {formOpen && (
        <FilterRuleForm
          key={editingId ?? "new"}
          initial={editingRule ? toInput(editingRule) : EMPTY_RULE}
          mailboxes={mailboxesQuery.data ?? []}
          onSubmit={(input) => {
            if (editingId) {
              updateMutation.mutate({ id: editingId, input });
            } else {
              createMutation.mutate(input);
            }
          }}
          onCancel={resetForm}
        />
      )}
    </div>
  );
}
