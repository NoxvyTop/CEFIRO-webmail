import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  VacationSettings as VacationSettingsData,
  VacationSettingsInput,
} from "@webmail/shared";
import { fetchSieveCapability, fetchVacationSettings, updateVacationSettings } from "./api";
import { settingsErrorKey } from "./errors";
import { SettingsLoadError, SettingsLoading, SettingsUnavailable } from "./PanelStates";
import { AdvancedModeNotice } from "./SieveAdvanced";

const VACATION_QUERY_KEY = ["mail", "vacation"] as const;
// Shared verbatim with FilterSettings (GH #36): both features are the same
// generated Sieve script, so they are the same question and must not each pay
// for their own answer.
const SIEVE_CAPABILITY_QUERY_KEY = ["mail", "sieve-capability"] as const;

function toInput(settings: VacationSettingsData): VacationSettingsInput {
  return {
    enabled: settings.enabled,
    subject: settings.subject,
    message: settings.message,
    startsAt: settings.startsAt,
    endsAt: settings.endsAt,
    intervalDays: settings.intervalDays,
  };
}

export function VacationSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const vacationQuery = useQuery({ queryKey: VACATION_QUERY_KEY, queryFn: fetchVacationSettings });
  const capabilityQuery = useQuery({
    queryKey: SIEVE_CAPABILITY_QUERY_KEY,
    queryFn: fetchSieveCapability,
  });

  const [form, setForm] = useState<VacationSettingsInput | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (vacationQuery.data && form === null) {
      setForm(toInput(vacationQuery.data));
    }
  }, [vacationQuery.data, form]);

  const saveMutation = useMutation({
    mutationFn: (input: VacationSettingsInput) => updateVacationSettings(input),
    onSuccess: async (data) => {
      setErrorKey(null);
      setSaved(true);
      setForm(toInput(data));
      await queryClient.invalidateQueries({ queryKey: VACATION_QUERY_KEY });
    },
    onError: (error) => setErrorKey(settingsErrorKey(error)),
  });

  // GH #36: an automatic reply is a Sieve `vacation` action, so a mail server
  // without the extension can never send one. Checked ahead of the form —
  // there is no point waiting on settings that could not be applied — and only
  // on a positive `false`, so an undecided or failed read changes nothing.
  if (capabilityQuery.data?.supported === false) {
    return <SettingsUnavailable messageKey="vacation.unavailable" />;
  }

  // GH #272: propagate #250's loading/error language here. A failed load used to
  // `return null` — a blank panel that says neither "loading" nor "we could not
  // read this", and offers no way to try again.
  if (vacationQuery.isError) {
    return (
      <SettingsLoadError error={vacationQuery.error} onRetry={() => void vacationQuery.refetch()} />
    );
  }

  if (!form) {
    return <SettingsLoading />;
  }

  function update(patch: Partial<VacationSettingsInput>) {
    setForm((previous) => (previous ? { ...previous, ...patch } : previous));
    setSaved(false);
    setErrorKey(null);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    if (form.enabled && form.message.trim() === "") {
      setErrorKey("settings.errors.vacationMessageRequired");
      return;
    }
    if (form.startsAt !== null && form.endsAt !== null && form.startsAt > form.endsAt) {
      setErrorKey("settings.errors.vacationDateOrder");
      return;
    }
    saveMutation.mutate(form);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {/* GH #23: an automatic reply is part of the same Sieve script the
          advanced editor takes over, so while a hand-written script owns the
          account this form saves and does not apply. Without this, the panel
          would answer a save with "Saved" for a reply that never goes out —
          the quietest failure this feature could produce. */}
      <AdvancedModeNotice messageKey="vacation.advancedNotice" />

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="vacation-enabled"
          checked={form.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        {t("vacation.enabled")}
      </label>

      <label htmlFor="vacation-subject" className="flex flex-col gap-1 text-sm">
        {t("vacation.subject")}
        <input
          id="vacation-subject"
          value={form.subject}
          maxLength={200}
          onChange={(event) => update({ subject: event.target.value })}
          className="h-11 rounded-input border border-line bg-soft px-3 text-ink field-focus"
        />
      </label>

      <label htmlFor="vacation-message" className="flex flex-col gap-1 text-sm">
        {t("vacation.message")}
        <textarea
          id="vacation-message"
          value={form.message}
          maxLength={5000}
          rows={4}
          onChange={(event) => update({ message: event.target.value })}
          className="rounded-input border border-line bg-soft px-3 py-2 text-ink field-focus"
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <label htmlFor="vacation-starts" className="flex flex-col gap-1 text-sm">
          {t("vacation.startsAt")}
          <input
            id="vacation-starts"
            type="date"
            value={form.startsAt ?? ""}
            onChange={(event) => update({ startsAt: event.target.value || null })}
            className="h-11 rounded-input border border-line bg-soft px-3 text-ink field-focus"
          />
        </label>

        <label htmlFor="vacation-ends" className="flex flex-col gap-1 text-sm">
          {t("vacation.endsAt")}
          <input
            id="vacation-ends"
            type="date"
            value={form.endsAt ?? ""}
            onChange={(event) => update({ endsAt: event.target.value || null })}
            className="h-11 rounded-input border border-line bg-soft px-3 text-ink field-focus"
          />
        </label>

        <label htmlFor="vacation-interval" className="flex flex-col gap-1 text-sm">
          {t("vacation.intervalDays")}
          <input
            id="vacation-interval"
            type="number"
            min={1}
            max={60}
            value={form.intervalDays}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              update({ intervalDays: Number.isNaN(parsed) ? 7 : Math.min(60, Math.max(1, parsed)) });
            }}
            className="h-11 w-24 rounded-input border border-line bg-soft px-3 text-ink field-focus"
          />
        </label>
      </div>

      {errorKey && (
        <p role="alert" className="text-sm text-danger">
          {t(errorKey)}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" className="self-start rounded-[11px] bg-accent px-3 py-1 text-sm font-semibold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]">
          {t("vacation.save")}
        </button>
        {saved && <span className="text-sm text-accent-text">{t("vacation.saved")}</span>}
      </div>
    </form>
  );
}
