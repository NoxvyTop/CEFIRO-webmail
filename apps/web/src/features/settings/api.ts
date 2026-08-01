import { z } from "zod";
import {
  filterRuleInputSchema,
  filterRuleSchema,
  profileViewSchema,
  sieveCapabilitySchema,
  sieveGeneratedScriptSchema,
  sieveRawScriptSchema,
  sieveSyncStateSchema,
  updateProfileSchema,
  vacationSettingsInputSchema,
  vacationSettingsSchema,
  type FilterRule,
  type FilterRuleInput,
  type ProfileView,
  type SieveCapability,
  type SieveGeneratedScript,
  type SieveRawScript,
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

/**
 * Whether this account's mail server can run Sieve at all (GH #36) — filters
 * and vacation are one generated script pushed over a JMAP EXTENSION, so a
 * provider that does not implement it can enforce neither.
 *
 * Asked before either editor is offered. Anything the server cannot determine
 * (no mail backend, no linked mailbox, provider unreachable) comes back as
 * supported, so a transient outage never hides a working feature.
 */
export async function fetchSieveCapability(): Promise<SieveCapability> {
  const res = await fetch("/api/mail/sieve/capability");
  if (!res.ok) return parseError(res);
  return sieveCapabilitySchema.parse(await res.json());
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

/**
 * The advanced-mode state (GH #23): which author owns the Sieve script this
 * account runs, and the script the user wrote by hand.
 *
 * Read by the Filters and Vacation panels on load, not only by the editor —
 * while a hand-written script owns the account, everything those two panels
 * show is stored but NOT being applied, and that has to be said out loud.
 */
export async function fetchSieveRawScript(): Promise<SieveRawScript> {
  const res = await fetch("/api/mail/filters/raw");
  if (!res.ok) return parseError(res);
  return sieveRawScriptSchema.parse(await res.json());
}

/**
 * The script the rule builder produces right now — what the advanced editor is
 * seeded with, so taking the script over never means retyping the rules.
 *
 * A separate request from the state above because the server pays a JMAP
 * session and a Mailbox/get to produce it, and only a user who actually opens
 * the editor should cost that.
 */
export async function fetchGeneratedSieveScript(): Promise<SieveGeneratedScript> {
  const res = await fetch("/api/mail/filters/raw/generated");
  if (!res.ok) return parseError(res);
  return sieveGeneratedScriptSchema.parse(await res.json());
}

/**
 * Saves a hand-written script and makes it the one that runs. Saving IS the
 * handover — see the server route for why there is no separate activation step.
 *
 * Rejected by the mail server's own parser: 422 `sieve_invalid`, and nothing is
 * stored.
 */
export async function saveSieveRawScript(script: string): Promise<SieveRawScript> {
  const res = await fetch("/api/mail/filters/raw", jsonRequest("PUT", { script }));
  if (!res.ok) return parseError(res);
  return sieveRawScriptSchema.parse(await res.json());
}

/**
 * Gives the script back to the rule builder. The hand-written script is kept,
 * deactivated — the way back must not be the thing that destroys it.
 */
export async function switchToRuleBuilder(): Promise<SieveRawScript> {
  const res = await fetch("/api/mail/filters/raw/rules", { method: "POST" });
  if (!res.ok) return parseError(res);
  return sieveRawScriptSchema.parse(await res.json());
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
