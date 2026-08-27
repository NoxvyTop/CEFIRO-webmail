import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MailApiError } from "../mailbox/api";
import {
  fetchGeneratedSieveScript,
  fetchSieveRawScript,
  saveSieveRawScript,
  switchToRuleBuilder,
} from "./api";
import { settingsErrorKey } from "./errors";
import { SettingsLoadError, SettingsLoading } from "./PanelStates";

/**
 * The advanced mode (GH #23): the raw Sieve editor, and the notice that tells
 * the rest of Settings it is on.
 *
 * THE OWNERSHIP MODEL, because it is the whole design decision:
 *
 * The rule builder and a hand-written script both want to own one server-side
 * script, and they are not merged. RFC 5228 §3.2 requires every `require` to
 * come before every other command, so keeping a delimited "managed block"
 * inside a user's script would mean hoisting and merging two `require` lists —
 * parsing arbitrary Sieve — and would still break the moment the user typed
 * inside the markers. So exactly one author is active, the handover is explicit
 * in both directions, and the hand-written script is NEVER destroyed by it: it
 * is kept, deactivated, and restored unchanged if the user comes back.
 *
 * That is what makes the take-over safe to offer with a single click. What it
 * costs is that the rules and vacation settings keep being stored and edited
 * while they are not being applied — which is a lie unless it is said out loud,
 * hence AdvancedModeNotice sitting on both panels.
 */

/**
 * Shared with the panels that only need the MODE. A child of `["mail",
 * "filters"]` on purpose: every filter mutation already invalidates that
 * prefix, so this stays in step without a second invalidation, and the
 * generated preview below is re-read when the rules it is built from change.
 */
export const SIEVE_RAW_QUERY_KEY = ["mail", "filters", "raw"] as const;
const GENERATED_SCRIPT_QUERY_KEY = ["mail", "filters", "raw", "generated"] as const;

interface AdvancedModeNoticeProps {
  /** What this particular panel is not applying while advanced mode is on. */
  messageKey: string;
}

/**
 * "What you are looking at is saved, but it is not what runs."
 *
 * Rendered by FilterSettings and VacationSettings rather than by the editor,
 * because the user who needs it is the one who is NOT in the editor — the rules
 * list looks exactly as active as it did before the handover.
 *
 * `role="status"`, matching the sync-state banner of GH #254: it is true on
 * arrival and every load, so announcing it assertively would interrupt for a
 * condition the user themselves created. Silent when the state cannot be read —
 * an unreadable advisory is not evidence of anything.
 */
export function AdvancedModeNotice({ messageKey }: AdvancedModeNoticeProps) {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: SIEVE_RAW_QUERY_KEY, queryFn: fetchSieveRawScript });

  if (data?.mode !== "raw") return null;

  return (
    <div
      data-testid="sieve-advanced-notice"
      role="status"
      className="rounded-md border border-warn/40 bg-soft p-2 text-sm text-warn"
    >
      {t(messageKey)}
    </div>
  );
}

/** The message for a save the mail server itself refused, or the shared map. */
function saveErrorKey(error: unknown): string {
  // 422 sieve_invalid means the provider's parser read this script and said no,
  // and nothing was stored. The shared `settings.errors.sieve_invalid` message
  // is about the GENERATED script and tells the user to call an administrator,
  // which is exactly wrong advice for a script they just typed themselves.
  if (error instanceof MailApiError && error.code === "sieve_invalid") {
    return "filters.advanced.rejected";
  }
  return settingsErrorKey(error);
}

/**
 * The editor itself, behind a disclosure: this is a power-user affordance, and
 * an account that never opens it should not pay the JMAP round-trip the
 * generated preview costs.
 */
export function SieveAdvancedEditor() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // GH #267: which of the two distinct scripts to show in the stored-but-inactive
  // case — the user's own saved hand-written script ("stored", the default and
  // the one a save would re-activate) or, read-only, the one the rules generate
  // and that is actually running right now ("generated"). Irrelevant in the
  // clean and active cases, where there is only one script to show.
  const [view, setView] = useState<"stored" | "generated">("stored");

  const rawQuery = useQuery({ queryKey: SIEVE_RAW_QUERY_KEY, queryFn: fetchSieveRawScript });
  const state = rawQuery.data;
  // A hand-written script was saved at some point (whether or not it runs now).
  const hasStored = !!state && state.script !== "";
  // GH #267: mode is `rules`, so what runs is the generated script — but a
  // hand-written one is stored and dormant. The header used to claim the
  // textarea was "the script your rules produce" while showing this dormant one,
  // so the user read their own old script as the output of their live rules.
  const isInactiveStored = !!state && state.mode === "rules" && hasStored;
  // Only seeded from the generated script when there is nothing stored to seed
  // from: a user who already has a script wants THAT script back, not a
  // regenerated one over it.
  const needsSeed = state?.script === "";
  const showGenerated = isInactiveStored && view === "generated";
  const generatedQuery = useQuery({
    queryKey: GENERATED_SCRIPT_QUERY_KEY,
    queryFn: fetchGeneratedSieveScript,
    // The clean case needs it as the seed; the inactive case fetches it only
    // when the user asks to see it — the generated preview is a JMAP round-trip.
    enabled: open && (needsSeed || showGenerated),
  });

  function beginMutation() {
    setErrorKey(null);
    setSaved(false);
  }

  function invalidateFilters() {
    // The `["mail", "filters"]` prefix, not just this key: taking the script
    // over changes whether the rules and vacation settings are being applied,
    // and their panels read that from the state above.
    return queryClient.invalidateQueries({ queryKey: ["mail", "filters"] });
  }

  const saveMutation = useMutation({
    mutationFn: (script: string) => saveSieveRawScript(script),
    onMutate: beginMutation,
    onSuccess: () => setSaved(true),
    onError: (error) => setErrorKey(saveErrorKey(error)),
    onSettled: () => invalidateFilters(),
  });

  const ruleBuilderMutation = useMutation({
    mutationFn: () => switchToRuleBuilder(),
    onMutate: beginMutation,
    // Back to the stored script as the textarea's source: it is retained
    // unchanged, so the editor keeps showing it and saving again re-activates
    // it — there is nothing here the user has to copy out first.
    onSuccess: () => setDraft(null),
    onError: (error) => setErrorKey(settingsErrorKey(error)),
    onSettled: () => invalidateFilters(),
  });

  // The editable, saveable script: the active hand-written one, the generated
  // seed in the clean case, or the dormant stored one waiting to be re-activated.
  const editableSeed = state ? state.script || generatedQuery.data?.script || "" : "";
  const script = draft ?? editableSeed;
  // What the textarea shows: the read-only generated preview when the user is
  // looking at it, otherwise the editable script. A draft typed on the stored
  // side survives a peek at the generated one — it is kept, not overwritten.
  const displayed = showGenerated ? (generatedQuery.data?.script ?? "") : script;
  const pending = saveMutation.isPending || ruleBuilderMutation.isPending;

  function body() {
    if (rawQuery.isError) {
      return <SettingsLoadError error={rawQuery.error} onRetry={() => void rawQuery.refetch()} />;
    }
    // Only fatal when the generated script IS the seed (the clean case). In the
    // inactive-stored case it is a secondary preview, so a failure there is
    // handled inline below without tearing down the editor and the stored script.
    if (generatedQuery.isError && needsSeed) {
      return (
        <SettingsLoadError
          error={generatedQuery.error}
          onRetry={() => void generatedQuery.refetch()}
        />
      );
    }
    if (!state || (needsSeed && !generatedQuery.data)) {
      return <SettingsLoading />;
    }

    const saveKey = isInactiveStored ? "filters.advanced.saveReactivate" : "filters.advanced.save";

    return (
      <>
        {/* GH #267: in the clean case this is the script the rules produce; once
            a hand-written script runs it is that script. The stored-but-inactive
            case gets its own honest notice below instead of either claim. */}
        {!isInactiveStored && (
          <p className="text-sm text-muted">
            {t(state.mode === "raw" ? "filters.advanced.active" : "filters.advanced.intro")}
          </p>
        )}

        {isInactiveStored && (
          <>
            <p className="text-sm text-warn">{t("filters.advanced.storedInactive")}</p>
            {/* The two scripts, told apart: the saved hand-written one and the
                one the rules generate — presented as one thing before. */}
            <div
              role="group"
              aria-label={t("filters.advanced.viewLabel")}
              className="flex flex-wrap gap-2"
            >
              <button
                type="button"
                aria-pressed={view === "stored"}
                onClick={() => setView("stored")}
                className={`rounded-[9px] border px-3 py-1 text-sm transition ${
                  view === "stored"
                    ? "border-accent bg-sel text-accent-text"
                    : "border-line-strong hover:border-accent hover:bg-hover"
                }`}
              >
                {t("filters.advanced.viewStored")}
              </button>
              <button
                type="button"
                aria-pressed={view === "generated"}
                onClick={() => setView("generated")}
                className={`rounded-[9px] border px-3 py-1 text-sm transition ${
                  view === "generated"
                    ? "border-accent bg-sel text-accent-text"
                    : "border-line-strong hover:border-accent hover:bg-hover"
                }`}
              >
                {t("filters.advanced.viewGenerated")}
              </button>
            </div>
          </>
        )}

        {showGenerated && generatedQuery.isError ? (
          <SettingsLoadError
            error={generatedQuery.error}
            onRetry={() => void generatedQuery.refetch()}
          />
        ) : showGenerated && !generatedQuery.data ? (
          <SettingsLoading />
        ) : (
          <label htmlFor="sieve-raw-script" className="flex flex-col gap-1 text-sm">
            {t(showGenerated ? "filters.advanced.generatedLabel" : "filters.advanced.label")}
            <textarea
              id="sieve-raw-script"
              value={displayed}
              rows={14}
              spellCheck={false}
              // The generated preview is read-only: it is here to be seen, not
              // edited — and never as the thing a save would activate.
              readOnly={showGenerated}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaved(false);
                setErrorKey(null);
              }}
              className="rounded-input border border-line bg-soft px-3 py-2 font-mono text-xs text-ink field-focus"
            />
          </label>
        )}

        {/* Shown BEFORE the first save, not after it: the button below is the
            handover, and a consequence explained afterwards is not a choice.
            Never over the read-only generated preview, which saves nothing. */}
        {state.mode === "rules" && !showGenerated && (
          <p className="text-sm text-warn">{t("filters.advanced.takeoverWarning")}</p>
        )}

        {errorKey && (
          <p role="alert" className="text-sm text-danger">
            {t(errorKey)}
          </p>
        )}
        {saved && !errorKey && (
          <p className="text-sm text-accent-text">{t("filters.advanced.saved")}</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {/* No save on the generated preview: there is nothing there to take
              over that the rules are not already running. */}
          {!showGenerated && (
            <button
              type="button"
              disabled={pending}
              onClick={() => saveMutation.mutate(script)}
              className="rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98] disabled:opacity-50"
            >
              {t(saveKey)}
            </button>
          )}
          {state.mode === "raw" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => ruleBuilderMutation.mutate()}
              className="rounded-[9px] border border-line-strong px-3 py-1 text-sm transition hover:border-accent hover:bg-hover disabled:opacity-50"
            >
              {t("filters.advanced.useRules")}
            </button>
          )}
        </div>

        {state.mode === "raw" && (
          <p className="text-xs text-muted">{t("filters.advanced.keptOnReturn")}</p>
        )}
      </>
    );
  }

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="self-start rounded-[9px] px-1 text-sm text-accent-text underline transition hover:bg-hover"
      >
        {t("filters.advanced.title")}
      </button>
      {open && body()}
    </section>
  );
}
