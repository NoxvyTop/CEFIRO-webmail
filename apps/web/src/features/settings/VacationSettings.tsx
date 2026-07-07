import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  VacationSettings as VacationSettingsData,
  VacationSettingsInput,
} from "@webmail/shared";
import { fetchVacationSettings, updateVacationSettings } from "./api";
import { settingsErrorKey } from "./errors";

const VACATION_QUERY_KEY = ["mail", "vacation"] as const;

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

  if (!form) {
    return null;
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
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
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
          className="rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"
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
          className="rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"
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
            className="rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"
          />
        </label>

        <label htmlFor="vacation-ends" className="flex flex-col gap-1 text-sm">
          {t("vacation.endsAt")}
          <input
            id="vacation-ends"
            type="date"
            value={form.endsAt ?? ""}
            onChange={(event) => update({ endsAt: event.target.value || null })}
            className="rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"
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
            className="w-24 rounded-md border border-line bg-soft p-1 text-ink outline-none focus:border-accent"
          />
        </label>
      </div>

      {errorKey && (
        <p role="alert" className="text-sm text-danger">
          {t(errorKey)}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" className="self-start rounded-md bg-accent px-3 py-1 text-sm text-white">
          {t("vacation.save")}
        </button>
        {saved && <span className="text-sm text-accent">{t("vacation.saved")}</span>}
      </div>
    </form>
  );
}
