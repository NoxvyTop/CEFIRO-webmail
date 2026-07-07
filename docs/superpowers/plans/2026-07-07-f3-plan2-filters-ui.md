# F3 Plan 2/3 — Filters & Vacation UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings-page UI for mail filter rules (Gmail-style builder: conditions + actions, reorder, enable/disable) and vacation auto-replies, consuming the F3 Plan 1 endpoints, with the sieve-sync error/retry flow surfaced to the user.

**Architecture:** Two new sections in the existing `/settings` page, following the SignatureSettings pattern exactly: TanStack Query + plain controlled forms + inline i18n'd errors (no toasts, no form libs, no dnd libs — reorder via up/down buttons). New `settings/api.ts` module wraps the Plan 1 endpoints with Zod parsing and the shared `MailApiError` envelope handling. See design §2–§4 in `docs/superpowers/specs/2026-07-07-phase3-sieve-filters-design.md`.

**Tech Stack:** existing — React 19, TanStack Query, i18next, Tailwind, Zod, Vitest + Testing Library. No new dependencies.

## Global Constraints

- English code/identifiers/comments/commits; UI copy ONLY via i18n keys, es (neutral Spanish) default / en fallback; conventional commits; no AI attribution; no compiled `.js` committed.
- TDD per task: write the test, run it and SEE IT FAIL (capture output), implement, see it pass; both outputs in the report.
- Follow the existing settings conventions exactly: query keys `["mail", "<resource>"]`; `vi.hoisted` + `vi.mock` of the sibling api module in component tests; `i18n.t(...)` for expected labels; inline error rendering via a computed i18n key (`settings.errors.<code>`), never raw codes.
- **`sieve_sync_failed` means the data WAS saved** — the UI must refresh the list AND show the banner with a "Reapply filters" retry button. Never present it as a data loss.
- The fileinto folder dropdown is populated from real mailboxes (never free text) and submits the mailbox PATH (names joined by `/` walking `parentId`), because the Sieve generator emits `fileinto` by name.
- Flag keyword input restricts to `[A-Za-z0-9$_.-]` (strip invalid chars on change) — mirrors the shared Zod schema.
- `apps/server` is NOT touched in this plan.
- NEVER kill processes globally; prefer running inside the dev container.
- Every task runs `bun run typecheck` (in apps/web) and its tests before committing.
- Branch: `init-sieve-ui`.

## Out of Scope (later)

- Manual forward in the composer — Plan 3.
- Raw Sieve editor — issue #23.
- Drag-and-drop reorder — up/down buttons only.

---

### Task 1: Settings API module + error keys + i18n

**Files:**
- Create: `apps/web/src/features/settings/api.ts`
- Create: `apps/web/src/features/settings/errors.ts`
- Modify: `apps/web/src/app/locales/en.json`, `apps/web/src/app/locales/es.json`
- Test: `apps/web/src/features/settings/api.test.ts`

**Interfaces (produces — Tasks 2–4 rely on these exact names):**
- `fetchFilterRules(): Promise<FilterRule[]>`, `createFilterRule(input)`, `updateFilterRule(id, input)`, `deleteFilterRule(id)`, `reorderFilterRules(ids: string[])`, `syncFilters(): Promise<{ status: string }>`, `fetchVacationSettings(): Promise<VacationSettings>`, `updateVacationSettings(input): Promise<VacationSettings>`
- `settingsErrorKey(error: unknown): string`

- [ ] **Step 1: Write the failing tests** — `apps/web/src/features/settings/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailApiError } from "../mailbox/api";
import {
  createFilterRule,
  fetchFilterRules,
  fetchVacationSettings,
  reorderFilterRules,
  syncFilters,
} from "./api";
import { settingsErrorKey } from "./errors";

const rule = {
  id: "r1",
  position: 0,
  name: "invoices",
  matchType: "all",
  conditions: [{ field: "from", op: "contains", value: "billing@" }],
  actions: [{ type: "fileinto", folder: "Invoices" }],
  enabled: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings api", () => {
  it("fetches and parses filter rules", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([rule]), { status: 200 })),
    );
    const rules = await fetchFilterRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe("invoices");
  });

  it("throws MailApiError with the envelope code on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: "sieve_sync_failed", message: "errors.sieve_sync_failed", traceId: "t1" }),
            { status: 502 },
          ),
      ),
    );
    await expect(
      createFilterRule({
        name: "x",
        matchType: "all",
        conditions: [{ field: "from", op: "contains", value: "a" }],
        actions: [{ type: "seen" }],
        enabled: true,
      }),
    ).rejects.toMatchObject({ status: 502, code: "sieve_sync_failed" });
  });

  it("sends the full ordered id list on reorder", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await reorderFilterRules(["b", "a"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/mail/filters/order");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({ ids: ["b", "a"] });
  });

  it("posts to the sync endpoint and returns the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
    );
    const result = await syncFilters();
    expect(result.status).toBe("ok");
  });

  it("parses vacation settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              enabled: false,
              subject: "",
              message: "",
              startsAt: null,
              endsAt: null,
              intervalDays: 7,
            }),
            { status: 200 },
          ),
      ),
    );
    const settings = await fetchVacationSettings();
    expect(settings.intervalDays).toBe(7);
  });
});

describe("settingsErrorKey", () => {
  it("maps known codes to settings error keys", () => {
    expect(settingsErrorKey(new MailApiError(502, "sieve_sync_failed"))).toBe(
      "settings.errors.sieve_sync_failed",
    );
    expect(settingsErrorKey(new MailApiError(400, "invalid_order"))).toBe(
      "settings.errors.invalid_order",
    );
  });

  it("falls back to generic for unknown errors", () => {
    expect(settingsErrorKey(new Error("boom"))).toBe("settings.errors.generic");
    expect(settingsErrorKey(new MailApiError(500, "internal"))).toBe("settings.errors.generic");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- src/features/settings/api.test.ts`
Expected: FAIL — cannot resolve `./api` / `./errors`.

- [ ] **Step 3: Implement** — `apps/web/src/features/settings/api.ts`:

```ts
import { z } from "zod";
import {
  filterRuleInputSchema,
  filterRuleSchema,
  vacationSettingsInputSchema,
  vacationSettingsSchema,
  type FilterRule,
  type FilterRuleInput,
  type VacationSettings,
  type VacationSettingsInput,
} from "@webmail/shared";
import { MailApiError } from "../mailbox/api";

async function parseError(res: Response): Promise<never> {
  let code = "internal";
  try {
    code = ((await res.json()) as { code?: string }).code ?? "internal";
  } catch {
    // non-json error body — keep default code
  }
  throw new MailApiError(res.status, code);
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function fetchFilterRules(): Promise<FilterRule[]> {
  const res = await fetch("/api/mail/filters");
  if (!res.ok) return parseError(res);
  return z.array(filterRuleSchema).parse(await res.json());
}

export async function createFilterRule(input: FilterRuleInput): Promise<FilterRule> {
  const res = await fetch("/api/mail/filters", jsonRequest("POST", filterRuleInputSchema.parse(input)));
  if (!res.ok) return parseError(res);
  return filterRuleSchema.parse(await res.json());
}

export async function updateFilterRule(id: string, input: FilterRuleInput): Promise<FilterRule> {
  const res = await fetch(
    `/api/mail/filters/${encodeURIComponent(id)}`,
    jsonRequest("PUT", filterRuleInputSchema.parse(input)),
  );
  if (!res.ok) return parseError(res);
  return filterRuleSchema.parse(await res.json());
}

export async function deleteFilterRule(id: string): Promise<void> {
  const res = await fetch(`/api/mail/filters/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) return parseError(res);
}

export async function reorderFilterRules(ids: string[]): Promise<void> {
  const res = await fetch("/api/mail/filters/order", jsonRequest("PUT", { ids }));
  if (!res.ok) return parseError(res);
}

export async function syncFilters(): Promise<{ status: string }> {
  const res = await fetch("/api/mail/filters/sync", { method: "POST" });
  if (!res.ok) return parseError(res);
  return z.object({ status: z.string() }).parse(await res.json());
}

export async function fetchVacationSettings(): Promise<VacationSettings> {
  const res = await fetch("/api/mail/vacation");
  if (!res.ok) return parseError(res);
  return vacationSettingsSchema.parse(await res.json());
}

export async function updateVacationSettings(
  input: VacationSettingsInput,
): Promise<VacationSettings> {
  const res = await fetch("/api/mail/vacation", jsonRequest("PUT", vacationSettingsInputSchema.parse(input)));
  if (!res.ok) return parseError(res);
  return vacationSettingsSchema.parse(await res.json());
}
```

And `apps/web/src/features/settings/errors.ts`:

```ts
import { MailApiError } from "../mailbox/api";

const KNOWN_CODES = new Set([
  "invalid_body",
  "invalid_order",
  "not_found",
  "sieve_invalid",
  "sieve_sync_failed",
]);

export function settingsErrorKey(error: unknown): string {
  if (error instanceof MailApiError && KNOWN_CODES.has(error.code)) {
    return `settings.errors.${error.code}`;
  }
  return "settings.errors.generic";
}
```

- [ ] **Step 4: Add the i18n keys**

In `apps/web/src/app/locales/en.json`: inside the existing `"settings"` object add an `"errors"` object, and add two NEW top-level blocks `"filters"` and `"vacation"` (siblings of `"settings"`, `"composer"`, `"admin"`):

```json
  "settings": {
    "...existing keys unchanged...": "KEEP AS IS — only ADD the errors object below",
    "errors": {
      "invalid_body": "The data is not valid",
      "invalid_order": "The rule order is out of date — reload and try again",
      "not_found": "Not found",
      "sieve_invalid": "The generated filter script was rejected — contact your administrator",
      "sieve_sync_failed": "Saved, but not applied to the mail server yet",
      "vacationMessageRequired": "Write a message for the automatic reply",
      "generic": "Something went wrong"
    }
  },
  "filters": {
    "title": "Filters",
    "newRule": "New rule",
    "name": "Name",
    "matchType": "Match",
    "matchAll": "All conditions",
    "matchAny": "Any condition",
    "conditions": "Conditions",
    "actions": "Actions",
    "field": "Field",
    "op": "Operator",
    "value": "Value",
    "action": "Action",
    "addCondition": "Add condition",
    "addAction": "Add action",
    "remove": "Remove",
    "field_from": "From",
    "field_to": "To or Cc",
    "field_subject": "Subject",
    "field_body": "Body",
    "op_contains": "contains",
    "op_is": "is exactly",
    "action_fileinto": "Move to folder",
    "action_seen": "Mark as read",
    "action_flag": "Add label",
    "action_delete": "Move to trash",
    "action_stop": "Stop applying rules",
    "keyword": "Label",
    "folder": "Folder",
    "enabled": "Enabled",
    "disabled": "Disabled",
    "moveUp": "Move up",
    "moveDown": "Move down",
    "reapply": "Reapply filters",
    "reapplied": "Filters applied",
    "empty": "No rules yet"
  },
  "vacation": {
    "title": "Automatic replies",
    "enabled": "Enable automatic replies",
    "subject": "Subject (optional)",
    "message": "Message",
    "startsAt": "Start date (optional)",
    "endsAt": "End date (optional)",
    "intervalDays": "Days between replies to the same sender",
    "save": "Save",
    "saved": "Saved"
  }
```

In `apps/web/src/app/locales/es.json`, same structure (neutral Spanish):

```json
  "settings": {
    "...existing keys unchanged...": "KEEP AS IS — only ADD the errors object below",
    "errors": {
      "invalid_body": "Los datos no son válidos",
      "invalid_order": "El orden de las reglas está desactualizado; recarga e inténtalo de nuevo",
      "not_found": "No encontrado",
      "sieve_invalid": "El script de filtros generado fue rechazado; contacta con tu administrador",
      "sieve_sync_failed": "Guardado, pero aún no aplicado en el servidor de correo",
      "vacationMessageRequired": "Escribe un mensaje para la respuesta automática",
      "generic": "Algo salió mal"
    }
  },
  "filters": {
    "title": "Filtros",
    "newRule": "Nueva regla",
    "name": "Nombre",
    "matchType": "Coincidencia",
    "matchAll": "Todas las condiciones",
    "matchAny": "Cualquier condición",
    "conditions": "Condiciones",
    "actions": "Acciones",
    "field": "Campo",
    "op": "Operador",
    "value": "Valor",
    "action": "Acción",
    "addCondition": "Añadir condición",
    "addAction": "Añadir acción",
    "remove": "Quitar",
    "field_from": "De",
    "field_to": "Para o Cc",
    "field_subject": "Asunto",
    "field_body": "Cuerpo",
    "op_contains": "contiene",
    "op_is": "es exactamente",
    "action_fileinto": "Mover a carpeta",
    "action_seen": "Marcar como leído",
    "action_flag": "Añadir etiqueta",
    "action_delete": "Mover a la papelera",
    "action_stop": "No aplicar más reglas",
    "keyword": "Etiqueta",
    "folder": "Carpeta",
    "enabled": "Activada",
    "disabled": "Desactivada",
    "moveUp": "Subir",
    "moveDown": "Bajar",
    "reapply": "Reaplicar filtros",
    "reapplied": "Filtros aplicados",
    "empty": "Aún no hay reglas"
  },
  "vacation": {
    "title": "Respuestas automáticas",
    "enabled": "Activar respuestas automáticas",
    "subject": "Asunto (opcional)",
    "message": "Mensaje",
    "startsAt": "Fecha de inicio (opcional)",
    "endsAt": "Fecha de fin (opcional)",
    "intervalDays": "Días entre respuestas al mismo remitente",
    "save": "Guardar",
    "saved": "Guardado"
  }
```

(The `"...existing keys unchanged..."` line is an instruction, not JSON to paste: keep every existing `settings` key and only add the `errors` object.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- src/features/settings/api.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/web && bun run typecheck` — Expected: no errors.

```bash
git add apps/web/src/features/settings/api.ts apps/web/src/features/settings/errors.ts apps/web/src/features/settings/api.test.ts apps/web/src/app/locales/en.json apps/web/src/app/locales/es.json
git commit -m "feat(web): settings api client and i18n for filters and vacation"
```

---

### Task 2: Vacation auto-reply panel

**Files:**
- Create: `apps/web/src/features/settings/VacationSettings.tsx`
- Modify: `apps/web/src/features/settings/SettingsPage.tsx` (add section)
- Test: `apps/web/src/features/settings/vacation-settings.test.tsx`

**Interfaces:**
- Consumes: `fetchVacationSettings`, `updateVacationSettings` (Task 1), `settingsErrorKey` (Task 1).
- Produces: `VacationSettings` component (no props).

- [ ] **Step 1: Write the failing tests** — `apps/web/src/features/settings/vacation-settings.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { VacationSettings as VacationSettingsData } from "@webmail/shared";
import { VacationSettings } from "./VacationSettings";

const { fetchVacationSettings, updateVacationSettings } = vi.hoisted(() => ({
  fetchVacationSettings: vi.fn(),
  updateVacationSettings: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchVacationSettings, updateVacationSettings };
});

const settings: VacationSettingsData = {
  enabled: false,
  subject: "",
  message: "Back on the 20th",
  startsAt: null,
  endsAt: null,
  intervalDays: 7,
};

function renderVacation(data: VacationSettingsData = settings) {
  fetchVacationSettings.mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <VacationSettings />
    </QueryClientProvider>,
  );
}

describe("VacationSettings", () => {
  it("renders the loaded settings", async () => {
    renderVacation();
    expect(await screen.findByLabelText(i18n.t("vacation.message"))).toHaveValue(
      "Back on the 20th",
    );
    expect(screen.getByLabelText(i18n.t("vacation.enabled"))).not.toBeChecked();
  });

  it("saves the edited settings", async () => {
    updateVacationSettings.mockResolvedValueOnce({ ...settings, enabled: true });
    renderVacation();

    const enabledBox = await screen.findByLabelText(i18n.t("vacation.enabled"));
    fireEvent.click(enabledBox);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("vacation.save") }));

    await waitFor(() => expect(updateVacationSettings).toHaveBeenCalledTimes(1));
    expect(updateVacationSettings.mock.calls[0]?.[0]).toMatchObject({
      enabled: true,
      message: "Back on the 20th",
    });
    expect(await screen.findByText(i18n.t("vacation.saved"))).toBeInTheDocument();
  });

  it("blocks enabling with a blank message and shows the inline error", async () => {
    renderVacation({ ...settings, message: "" });

    const enabledBox = await screen.findByLabelText(i18n.t("vacation.enabled"));
    fireEvent.click(enabledBox);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("vacation.save") }));

    expect(
      await screen.findByText(i18n.t("settings.errors.vacationMessageRequired")),
    ).toBeInTheDocument();
    expect(updateVacationSettings).not.toHaveBeenCalled();
  });

  it("shows the sync-failed error from the server", async () => {
    const { MailApiError } = await import("../mailbox/api");
    updateVacationSettings.mockRejectedValueOnce(new MailApiError(502, "sieve_sync_failed"));
    renderVacation();

    await screen.findByLabelText(i18n.t("vacation.enabled"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("vacation.save") }));

    expect(
      await screen.findByText(i18n.t("settings.errors.sieve_sync_failed")),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- src/features/settings/vacation-settings.test.tsx`
Expected: FAIL — cannot resolve `./VacationSettings`.

- [ ] **Step 3: Implement** — `apps/web/src/features/settings/VacationSettings.tsx`:

```tsx
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
          className="rounded-md border p-1"
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
          className="rounded-md border p-1"
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
            className="rounded-md border p-1"
          />
        </label>

        <label htmlFor="vacation-ends" className="flex flex-col gap-1 text-sm">
          {t("vacation.endsAt")}
          <input
            id="vacation-ends"
            type="date"
            value={form.endsAt ?? ""}
            onChange={(event) => update({ endsAt: event.target.value || null })}
            className="rounded-md border p-1"
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
            className="w-24 rounded-md border p-1"
          />
        </label>
      </div>

      {errorKey && (
        <p role="alert" className="text-sm text-red-700">
          {t(errorKey)}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" className="self-start rounded-md bg-blue-600 px-3 py-1 text-sm text-white">
          {t("vacation.save")}
        </button>
        {saved && <span className="text-sm text-green-700">{t("vacation.saved")}</span>}
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Add the section** — in `apps/web/src/features/settings/SettingsPage.tsx`, import `VacationSettings` and append after the signatures section:

```tsx
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t("vacation.title")}</h2>
        <VacationSettings />
      </section>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- src/features/settings/vacation-settings.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/web && bun run typecheck` — Expected: no errors.

```bash
git add apps/web/src/features/settings/VacationSettings.tsx apps/web/src/features/settings/vacation-settings.test.tsx apps/web/src/features/settings/SettingsPage.tsx
git commit -m "feat(web): vacation auto-reply panel in settings"
```

---

### Task 3: Filter rule form component

**Files:**
- Create: `apps/web/src/features/settings/FilterRuleForm.tsx`
- Test: `apps/web/src/features/settings/filter-rule-form.test.tsx`

**Interfaces:**
- Consumes: `FilterAction`, `FilterCondition`, `FilterRuleInput`, `Mailbox` types from `@webmail/shared`.
- Produces (Task 4 relies on this): `FilterRuleForm` with props `{ initial: FilterRuleInput; mailboxes: Mailbox[]; onSubmit: (input: FilterRuleInput) => void; onCancel: () => void }`. Pure controlled component — no queries, no mutations.

- [ ] **Step 1: Write the failing tests** — `apps/web/src/features/settings/filter-rule-form.test.tsx`:

```tsx
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
    fireEvent.change(screen.getByLabelText(i18n.t("filters.value")), {
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
    fireEvent.change(screen.getByLabelText(i18n.t("filters.value")), {
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
    expect(screen.getAllByLabelText(i18n.t("filters.value"))).toHaveLength(2);

    const removeButtons = screen.getAllByRole("button", { name: i18n.t("filters.remove") });
    fireEvent.click(removeButtons[0]!);
    expect(screen.getAllByLabelText(i18n.t("filters.value"))).toHaveLength(1);
  });

  it("shows the folder dropdown with nested paths for a move action", () => {
    renderForm({
      initial: { ...emptyRule, actions: [{ type: "fileinto", folder: "Clients/Acme" }] },
    });
    const folderSelect = screen.getByLabelText(i18n.t("filters.folder"));
    expect(folderSelect).toHaveValue("Clients/Acme");
    expect(screen.getByRole("option", { name: "Clients/Acme" })).toBeInTheDocument();
  });

  it("strips invalid characters from the flag keyword", () => {
    renderForm({
      initial: { ...emptyRule, actions: [{ type: "flag", keyword: "" }] },
    });
    const keywordInput = screen.getByLabelText(i18n.t("filters.keyword"));
    fireEvent.change(keywordInput, { target: { value: 'Imp"ort ant!' } });
    expect(keywordInput).toHaveValue("Important");
  });

  it("changing the action type resets its parameters", () => {
    renderForm();
    const actionSelect = screen.getByLabelText(i18n.t("filters.action"));
    fireEvent.change(actionSelect, { target: { value: "fileinto" } });
    expect(screen.getByLabelText(i18n.t("filters.folder"))).toHaveValue("Inbox");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- src/features/settings/filter-rule-form.test.tsx`
Expected: FAIL — cannot resolve `./FilterRuleForm`.

- [ ] **Step 3: Implement** — `apps/web/src/features/settings/FilterRuleForm.tsx`:

```tsx
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
    let parent = mailbox.parentId ? byId.get(mailbox.parentId) : undefined;
    while (parent) {
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-md border p-3">
      <label htmlFor="filter-name" className="flex flex-col gap-1 text-sm">
        {t("filters.name")}
        <input
          id="filter-name"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          className="rounded-md border p-1"
        />
      </label>

      <label htmlFor="filter-match" className="flex flex-col gap-1 text-sm">
        {t("filters.matchType")}
        <select
          id="filter-match"
          value={matchType}
          onChange={(event) => setMatchType(event.target.value as FilterRuleInput["matchType"])}
          className="self-start rounded-md border p-1"
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
              aria-label={t("filters.field")}
              value={condition.field}
              onChange={(event) =>
                updateCondition(index, { field: event.target.value as FilterCondition["field"] })
              }
              className="rounded-md border p-1 text-sm"
            >
              {FIELD_OPTIONS.map((field) => (
                <option key={field} value={field}>
                  {t(`filters.field_${field}`)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("filters.op")}
              value={condition.op}
              onChange={(event) =>
                updateCondition(index, { op: event.target.value as FilterCondition["op"] })
              }
              className="rounded-md border p-1 text-sm"
            >
              {OP_OPTIONS.map((op) => (
                <option key={op} value={op}>
                  {t(`filters.op_${op}`)}
                </option>
              ))}
            </select>
            <input
              aria-label={t("filters.value")}
              value={condition.value}
              maxLength={500}
              onChange={(event) => updateCondition(index, { value: event.target.value })}
              className="min-w-40 flex-1 rounded-md border p-1 text-sm"
            />
            <button
              type="button"
              disabled={conditions.length === 1}
              onClick={() => setConditions(conditions.filter((_, i) => i !== index))}
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
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
            className="self-start rounded-md border px-2 py-1 text-xs"
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
              aria-label={t("filters.action")}
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
              className="rounded-md border p-1 text-sm"
            >
              {ACTION_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {t(`filters.action_${type}`)}
                </option>
              ))}
            </select>
            {action.type === "fileinto" && (
              <select
                aria-label={t("filters.folder")}
                value={action.folder}
                onChange={(event) =>
                  setActions(
                    actions.map((item, i) =>
                      i === index ? { type: "fileinto", folder: event.target.value } : item,
                    ),
                  )
                }
                className="rounded-md border p-1 text-sm"
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
                aria-label={t("filters.keyword")}
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
                className="rounded-md border p-1 text-sm"
              />
            )}
            <button
              type="button"
              disabled={actions.length === 1}
              onClick={() => setActions(actions.filter((_, i) => i !== index))}
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
            >
              {t("filters.remove")}
            </button>
          </div>
        ))}
        {actions.length < MAX_ITEMS && (
          <button
            type="button"
            onClick={() => setActions([...actions, { type: "seen" }])}
            className="self-start rounded-md border px-2 py-1 text-xs"
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
        <button type="button" onClick={onCancel} className="rounded-md border px-3 py-1 text-sm">
          {t("composer.cancel")}
        </button>
        <button
          type="submit"
          disabled={!valid}
          className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          {t("settings.save")}
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- src/features/settings/filter-rule-form.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && bun run typecheck` — Expected: no errors.

```bash
git add apps/web/src/features/settings/FilterRuleForm.tsx apps/web/src/features/settings/filter-rule-form.test.tsx
git commit -m "feat(web): filter rule builder form component"
```

---

### Task 4: Filter list with reorder, toggle, sync retry

**Files:**
- Create: `apps/web/src/features/settings/FilterSettings.tsx`
- Modify: `apps/web/src/features/settings/SettingsPage.tsx` (add section BEFORE the vacation section)
- Test: `apps/web/src/features/settings/filter-settings.test.tsx`

**Interfaces:**
- Consumes: Task 1 api functions + `settingsErrorKey`; `FilterRuleForm` (Task 3); `fetchMailboxes` + `MailApiError` from `../mailbox/api`.
- Produces: `FilterSettings` component (no props).

Behavior contract:
- List rules ordered as returned; each row: name, then Move up / Move down / state-toggle / Edit / Delete buttons. The state toggle is ONE button showing the CURRENT state (`filters.enabled` / `filters.disabled`) with `aria-pressed`, and clicking it flips the rule — no separate badge (avoids duplicate accessible names).
- Reorder sends the FULL id list with the two neighbors swapped.
- Toggle sends `updateFilterRule(id, { ...ruleAsInput, enabled: !rule.enabled })`.
- On any mutation error: banner (`role="alert"`) with `t(settingsErrorKey(error))`; when the key is `settings.errors.sieve_sync_failed` also render the "Reapply filters" button which calls `syncFilters()`; on reapply success clear the banner and show `filters.reapplied`.
- The list is invalidated after EVERY mutation (`onSettled`) — including failures, because `sieve_sync_failed` means the write persisted.
- The create/edit form closes on success; it also closes when the failure is a sieve sync error (data was saved); it stays open on other failures.

- [ ] **Step 1: Write the failing tests** — `apps/web/src/features/settings/filter-settings.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../app/i18n";
import i18n from "../../app/i18n";
import type { FilterRule, Mailbox } from "@webmail/shared";
import { MailApiError } from "../mailbox/api";
import { FilterSettings } from "./FilterSettings";

const {
  fetchFilterRules,
  createFilterRule,
  updateFilterRule,
  deleteFilterRule,
  reorderFilterRules,
  syncFilters,
} = vi.hoisted(() => ({
  fetchFilterRules: vi.fn(),
  createFilterRule: vi.fn(),
  updateFilterRule: vi.fn(),
  deleteFilterRule: vi.fn(),
  reorderFilterRules: vi.fn(),
  syncFilters: vi.fn(),
}));

const { fetchMailboxes } = vi.hoisted(() => ({ fetchMailboxes: vi.fn() }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchFilterRules,
    createFilterRule,
    updateFilterRule,
    deleteFilterRule,
    reorderFilterRules,
    syncFilters,
  };
});

vi.mock("../mailbox/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mailbox/api")>();
  return { ...actual, fetchMailboxes };
});

const mailboxes: Mailbox[] = [
  { id: "m1", name: "Inbox", parentId: null, role: "inbox", sortOrder: 0, unreadEmails: 0, totalEmails: 0 },
];

const ruleA: FilterRule = {
  id: "a",
  position: 0,
  name: "invoices",
  matchType: "all",
  conditions: [{ field: "from", op: "contains", value: "billing@" }],
  actions: [{ type: "seen" }],
  enabled: true,
};

const ruleB: FilterRule = { ...ruleA, id: "b", position: 1, name: "newsletters" };

function renderFilters(rules: FilterRule[] = [ruleA, ruleB]) {
  fetchFilterRules.mockResolvedValue(rules);
  fetchMailboxes.mockResolvedValue(mailboxes);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FilterSettings />
    </QueryClientProvider>,
  );
}

describe("FilterSettings", () => {
  it("lists rules in order with their state toggles", async () => {
    renderFilters([ruleA, { ...ruleB, enabled: false }]);
    expect(await screen.findByText("invoices")).toBeInTheDocument();
    expect(screen.getByText("newsletters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("filters.enabled") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("filters.disabled") })).toBeInTheDocument();
  });

  it("shows the empty state without rules", async () => {
    renderFilters([]);
    expect(await screen.findByText(i18n.t("filters.empty"))).toBeInTheDocument();
  });

  it("creates a rule through the form", async () => {
    createFilterRule.mockResolvedValueOnce({ ...ruleA, id: "c", name: "clients" });
    renderFilters();

    await screen.findByText("invoices");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("filters.newRule") }));

    fireEvent.change(screen.getByLabelText(i18n.t("filters.name")), {
      target: { value: "clients" },
    });
    fireEvent.change(screen.getByLabelText(i18n.t("filters.value")), {
      target: { value: "@client.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.save") }));

    await waitFor(() => expect(createFilterRule).toHaveBeenCalledTimes(1));
    expect(createFilterRule.mock.calls[0]?.[0]).toMatchObject({ name: "clients" });
  });

  it("swaps neighbors and sends the full id list on move down", async () => {
    reorderFilterRules.mockResolvedValueOnce(undefined);
    renderFilters();

    await screen.findByText("invoices");
    const moveDownButtons = screen.getAllByRole("button", { name: i18n.t("filters.moveDown") });
    fireEvent.click(moveDownButtons[0]!);

    await waitFor(() => expect(reorderFilterRules).toHaveBeenCalledWith(["b", "a"]));
  });

  it("toggles a rule's enabled flag", async () => {
    updateFilterRule.mockResolvedValueOnce({ ...ruleA, enabled: false });
    renderFilters();

    await screen.findByText("invoices");
    // the toggle button shows the CURRENT state; both rules are enabled here
    const toggles = screen.getAllByRole("button", { name: i18n.t("filters.enabled") });
    fireEvent.click(toggles[0]!);

    await waitFor(() => expect(updateFilterRule).toHaveBeenCalledTimes(1));
    expect(updateFilterRule.mock.calls[0]?.[0]).toBe("a");
    expect(updateFilterRule.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
  });

  it("deletes a rule", async () => {
    deleteFilterRule.mockResolvedValueOnce(undefined);
    renderFilters();

    await screen.findByText("invoices");
    const deleteButtons = screen.getAllByRole("button", { name: i18n.t("settings.delete") });
    fireEvent.click(deleteButtons[0]!);

    await waitFor(() => expect(deleteFilterRule).toHaveBeenCalledWith("a"));
  });

  it("shows the sync-failed banner with a working retry button", async () => {
    deleteFilterRule.mockRejectedValueOnce(new MailApiError(502, "sieve_sync_failed"));
    syncFilters.mockResolvedValueOnce({ status: "ok" });
    renderFilters();

    await screen.findByText("invoices");
    fireEvent.click(screen.getAllByRole("button", { name: i18n.t("settings.delete") })[0]!);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(i18n.t("settings.errors.sieve_sync_failed"));

    fireEvent.click(screen.getByRole("button", { name: i18n.t("filters.reapply") }));
    await waitFor(() => expect(syncFilters).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(i18n.t("filters.reapplied"))).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test -- src/features/settings/filter-settings.test.tsx`
Expected: FAIL — cannot resolve `./FilterSettings`.

- [ ] **Step 3: Implement** — `apps/web/src/features/settings/FilterSettings.tsx`:

```tsx
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
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-700"
        >
          <span>{t(errorKey)}</span>
          {errorKey === "settings.errors.sieve_sync_failed" && (
            <button
              type="button"
              onClick={() => syncMutation.mutate()}
              className="rounded-md border border-red-300 px-2 py-1 text-xs"
            >
              {t("filters.reapply")}
            </button>
          )}
        </div>
      )}
      {reapplied && !errorKey && (
        <p className="text-sm text-green-700">{t("filters.reapplied")}</p>
      )}

      {rules.length === 0 && !filtersQuery.isLoading && (
        <p className="text-sm text-gray-600">{t("filters.empty")}</p>
      )}

      <ul className="flex flex-col gap-2">
        {rules.map((rule, index) => (
          <li
            key={rule.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
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
                className="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={t("filters.moveDown")}
                disabled={index === rules.length - 1}
                onClick={() => move(index, 1)}
                className="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
              >
                ↓
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
                    ? "rounded-md border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700"
                    : "rounded-md border px-2 py-1 text-xs text-gray-600"
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
                className="rounded-md border px-2 py-1 text-xs"
              >
                {t("settings.edit")}
              </button>
              <button
                type="button"
                onClick={() => deleteMutation.mutate(rule.id)}
                className="rounded-md border px-2 py-1 text-xs"
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
          className="self-start rounded-md border px-3 py-1 text-sm"
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
```

- [ ] **Step 4: Add the section** — in `apps/web/src/features/settings/SettingsPage.tsx`, import `FilterSettings` and insert BETWEEN the signatures section and the vacation section:

```tsx
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t("filters.title")}</h2>
        <FilterSettings />
      </section>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && bun run test -- src/features/settings/filter-settings.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/web && bun run typecheck` — Expected: no errors.

```bash
git add apps/web/src/features/settings/FilterSettings.tsx apps/web/src/features/settings/filter-settings.test.tsx apps/web/src/features/settings/SettingsPage.tsx
git commit -m "feat(web): filter rules list with reorder, toggle and sync retry"
```

---

### Task 5: Verification sweep

**Files:** none expected (fixes only if something is broken).

- [ ] **Step 1: Full web suite** — `cd apps/web && bun run test` — Expected: PASS, no regressions.
- [ ] **Step 2: Full server suite** — `cd apps/server && bun run test` — Expected: PASS (nothing server-side changed; guard against accidental edits).
- [ ] **Step 3: Typechecks** — `cd apps/web && bun run typecheck` and `cd packages/shared && bun run typecheck` — Expected: no errors.
- [ ] **Step 4: Production build** — `cd apps/web && bun run build` — Expected: vite build succeeds.
- [ ] **Step 5: Commit** — only if fixes were needed; otherwise report clean.
