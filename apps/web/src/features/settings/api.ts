import { z } from "zod";
import {
  filterRuleInputSchema,
  filterRuleSchema,
  profileViewSchema,
  sieveSyncStateSchema,
  updateProfileSchema,
  vacationSettingsInputSchema,
  vacationSettingsSchema,
  type FilterRule,
  type FilterRuleInput,
  type ProfileView,
  type SieveSyncState,
  type UpdateProfileInput,
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

/**
 * Whether the filters this API lists are the ones Stalwart is actually running
 * (GH #221 on the server, GH #254 in the UI).
 *
 * Reading it is not free of side effects by design: the server uses the read as
 * its reconciliation point and retries an unapplied push, once per cooldown —
 * so opening the settings page is what repairs an outage that has since ended.
 */
export async function fetchFilterSyncState(): Promise<SieveSyncState> {
  const res = await fetch("/api/mail/filters/sync-state");
  if (!res.ok) return parseError(res);
  return sieveSyncStateSchema.parse(await res.json());
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

export async function fetchProfile(): Promise<ProfileView> {
  const res = await fetch("/api/profile");
  if (!res.ok) return parseError(res);
  return profileViewSchema.parse(await res.json());
}

export async function updateProfile(input: UpdateProfileInput): Promise<ProfileView> {
  const res = await fetch("/api/profile", jsonRequest("PATCH", updateProfileSchema.parse(input)));
  if (!res.ok) return parseError(res);
  return profileViewSchema.parse(await res.json());
}
