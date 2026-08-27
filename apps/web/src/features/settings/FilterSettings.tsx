import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { FilterRule, FilterRuleInput, SieveSyncState } from "@webmail/shared";
import { MailApiError, fetchMailboxes } from "../mailbox/api";
import {
  createFilterRule,
  deleteFilterRule,
  fetchFilterRules,
  fetchFilterSyncState,
  fetchSieveCapability,
  reorderFilterRules,
  syncFilters,
  updateFilterRule,
} from "./api";
import { settingsErrorKey } from "./errors";
import { FilterRuleForm } from "./FilterRuleForm";
import { SettingsLoadError, SettingsLoading, SettingsUnavailable } from "./PanelStates";
import { AdvancedModeNotice, SieveAdvancedEditor } from "./SieveAdvanced";
import { ChevronDownIcon, ChevronUpIcon } from "../../app/ui/icons";

const FILTERS_QUERY_KEY = ["mail", "filters"] as const;
// GH #36. NOT a child of FILTERS_QUERY_KEY: what a mail server is capable of
// does not change because a rule was saved, and re-asking on every mutation
// would spend a JMAP session fetch to learn the same answer.
const SIEVE_CAPABILITY_QUERY_KEY = ["mail", "sieve-capability"] as const;
// A child of FILTERS_QUERY_KEY on purpose: every mutation below already
// invalidates the `["mail", "filters"]` prefix, so the sync state is re-read
// after each save without a second invalidation to keep in step with it.
const SYNC_STATE_QUERY_KEY = ["mail", "filters", "sync-state"] as const;

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

interface SyncWarning {
  messageKey: string;
  /**
   * Whether pushing the script again has any chance of working. `sieve_invalid`
   * means Stalwart refused the generated script itself, so the same script will
   * be refused again — offering a retry there would only teach the user that
   * the button does nothing.
   */
  retryable: boolean;
}

/**
 * GH #254: what a non-`synced` sieve state means for the user.
 *
 * #221 made the server record whether the Sieve script Stalwart runs still
 * matches the rules stored here, but nothing read it: FilterSettings only ever
 * mentioned a sync failure while the failing mutation was still on screen, so
 * one reload turned a rule that is saved but NOT being applied back into a rule
 * that looks active. Reading the state on load is what closes that gap.
 */
function syncWarningFor(state: SieveSyncState): SyncWarning | null {
  if (state.status === "synced") return null;
  // Saved locally, never pushed — typically Stalwart was unreachable, or mail
  // is not configured for this user yet. Worth another attempt.
  if (state.status === "pending") return { messageKey: "filters.sync.pending", retryable: true };
  if (state.lastError === "sieve_invalid") {
    return { messageKey: "filters.sync.invalid", retryable: false };
  }
  return { messageKey: "filters.sync.failed", retryable: true };
}

export function FilterSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const filtersQuery = useQuery({ queryKey: FILTERS_QUERY_KEY, queryFn: fetchFilterRules });
  // Filters are a personal-mailbox setting, so this always reads the personal
  // folder list (no accountId) — see fetchMailboxes' optional accountId param
  // (GH #13/#50), wrapped here because a bare queryFn would be handed React
  // Query's context object as its first argument.
  const mailboxesQuery = useQuery({ queryKey: ["mail", "mailboxes"], queryFn: () => fetchMailboxes() });
  // Advisory only (GH #254): if this read itself fails there is nothing
  // trustworthy to say about the sync state, so the banner simply stays away
  // rather than inventing a warning out of a failed request.
  const syncStateQuery = useQuery({ queryKey: SYNC_STATE_QUERY_KEY, queryFn: fetchFilterSyncState });
  // GH #36: whether this mail server can enforce filters at all. Also advisory
  // in the same sense as the sync state — a read that fails says nothing, and
  // the editor stays as it is rather than being withdrawn on a failed request.
  const capabilityQuery = useQuery({
    queryKey: SIEVE_CAPABILITY_QUERY_KEY,
    queryFn: fetchSieveCapability,
  });

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
    // GH #254: re-read the sync state either way. `reapplied` only hides the
    // banner for this session; what has to change is the state the NEXT load
    // reads, and a failed retry must leave the warning standing on fresh
    // evidence rather than on the stale copy it was rendered from.
    onSettled: () => invalidateFilters(),
  });

  const rules = filtersQuery.data ?? [];
  const editingRule = editingId ? rules.find((rule) => rule.id === editingId) : undefined;
  // Suppressed for the rest of the session's reapply round-trip: the mutation
  // has already told the user it worked, and the refetched state confirms it a
  // moment later, so showing the stale warning in between would only flicker.
  const syncWarning =
    syncStateQuery.data && !reapplied ? syncWarningFor(syncStateQuery.data) : null;

  function move(index: number, delta: number) {
    const ids = rules.map((rule) => rule.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorderMutation.mutate(ids);
  }

  // GH #250: a failed load is its own state. Gating the empty state on
  // `isLoading` alone meant a rules list that could not be fetched rendered as
  // "no rules yet" — the UI asserting the user has nothing configured when it
  // simply does not know.
  if (filtersQuery.isError) {
    return (
      <SettingsLoadError error={filtersQuery.error} onRetry={() => void filtersQuery.refetch()} />
    );
  }

  if (filtersQuery.isLoading) {
    return <SettingsLoading />;
  }

  // GH #36: only a positive `false` withdraws the editor, and only after the
  // rules themselves have loaded — so an undecided or failed capability read
  // leaves the panel exactly as it was, and there is no flash of "unavailable"
  // on the way to a server that supports it perfectly well.
  if (capabilityQuery.data?.supported === false) {
    return <SettingsUnavailable messageKey="filters.unavailable" />;
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
        <p className="text-sm text-accent-text">{t("filters.reapplied")}</p>
      )}

      {/* GH #254: role="status" (polite), not "alert" — this is read on every
          load, and an assertive announcement on arrival would interrupt the
          user for a condition that has been true since before they got here.
          The retry is offered by the state itself, not by whether the failure
          happened to occur in this session. */}
      {syncWarning && (
        <div
          data-testid="sieve-sync-warning"
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/40 bg-soft p-2 text-sm text-warn"
        >
          <span>{t(syncWarning.messageKey)}</span>
          {syncWarning.retryable && (
            <button
              type="button"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="rounded-md border border-warn/40 px-2 py-1 text-xs hover:bg-hover disabled:opacity-50"
            >
              {t("filters.reapply")}
            </button>
          )}
        </div>
      )}

      {/* GH #23: while a hand-written script owns the account, everything below
          is stored and editable and NOT being applied. The list gives no sign
          of that on its own — a rule still reads as enabled — so this is the
          only thing standing between the user and a filter they believe is
          running. The rules stay editable on purpose: they are what comes back
          when the script is handed over again. */}
      <AdvancedModeNotice messageKey="filters.advanced.notice" />

      {rules.length === 0 && (
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
                className="rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover disabled:opacity-50"
              >
                <ChevronUpIcon size={14} />
              </button>
              <button
                type="button"
                aria-label={t("filters.moveDown")}
                disabled={index === rules.length - 1}
                onClick={() => move(index, 1)}
                className="rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover disabled:opacity-50"
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
                    ? "rounded-full border border-accent/40 bg-sel px-2 py-0.5 text-xs text-accent-text"
                    : "rounded-full border border-line px-2 py-0.5 text-xs text-muted transition hover:bg-hover"
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
                className="rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover"
              >
                {t("settings.edit")}
              </button>
              <button
                type="button"
                onClick={() => deleteMutation.mutate(rule.id)}
                className="rounded-[9px] px-2 py-1 text-xs transition hover:bg-hover"
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
          className="self-start rounded-[9px] border border-line-strong px-3 py-1 text-sm transition hover:border-accent hover:bg-hover"
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

      {/* Below the builder, and only reachable by opening it: the raw editor is
          for the rules the builder does not cover, not the way in. It sits
          inside this panel so GH #36's capability gate above covers it too — a
          mail server that cannot run Sieve is never offered an editor for it. */}
      <SieveAdvancedEditor />
    </div>
  );
}
