import { z } from "zod";

const singleLine = (max: number) =>
  z.string().max(max).regex(/^[^\u0000-\u001f\u007f]*$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const filterConditionSchema = z.object({
  field: z.enum(["from", "to", "subject", "body"]),
  op: z.enum(["contains", "is"]),
  value: singleLine(500).min(1),
});
export type FilterCondition = z.infer<typeof filterConditionSchema>;

export const filterActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fileinto"), folder: singleLine(200).min(1) }),
  z.object({ type: z.literal("seen") }),
  z.object({
    type: z.literal("flag"),
    keyword: z.string().min(1).max(64).regex(/^[A-Za-z0-9$_.-]+$/),
  }),
  z.object({ type: z.literal("delete") }),
  z.object({ type: z.literal("stop") }),
]);
export type FilterAction = z.infer<typeof filterActionSchema>;

export const filterRuleSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  name: z.string(),
  matchType: z.enum(["all", "any"]),
  conditions: z.array(filterConditionSchema),
  actions: z.array(filterActionSchema),
  enabled: z.boolean(),
});
export type FilterRule = z.infer<typeof filterRuleSchema>;

export const filterRuleInputSchema = z.object({
  name: singleLine(100).min(1),
  matchType: z.enum(["all", "any"]),
  conditions: z.array(filterConditionSchema).min(1).max(10),
  actions: z.array(filterActionSchema).min(1).max(10),
  enabled: z.boolean().default(true),
});
export type FilterRuleInput = z.infer<typeof filterRuleInputSchema>;

export const filterOrderSchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
});
export type FilterOrder = z.infer<typeof filterOrderSchema>;

/**
 * Whether the Sieve script Stalwart enforces still matches the filter rules and
 * vacation settings this server stores (GH #221).
 *
 * - `synced`: the last push succeeded; what is listed is what runs.
 * - `pending`: there is a change this server has not managed to push yet —
 *   typically Stalwart was unreachable, or mail is not configured for this user.
 *   The rules are saved but NOT being applied.
 * - `failed`: the last push was refused. `lastError` carries the code
 *   (`sieve_invalid` means the generated script itself was rejected and
 *   retrying will not help; anything else is worth another attempt).
 */
export const sieveSyncStateSchema = z.object({
  status: z.enum(["synced", "pending", "failed"]),
  /** Consecutive failed attempts since the last successful push. */
  attempts: z.number().int(),
  /** Error code of the last failure, never a raw message. */
  lastError: z.string().nullable(),
  /** When this state was last written; null when nothing was ever pushed. */
  updatedAt: z.string().nullable(),
});
export type SieveSyncState = z.infer<typeof sieveSyncStateSchema>;

/**
 * Whether this account's JMAP provider can run Sieve at all (GH #36).
 *
 * Filters and vacation are one generated Sieve script pushed over
 * `urn:ietf:params:jmap:sieve`, which is an EXTENSION: a provider is free not
 * to implement it, and one that does not cannot enforce either feature. The
 * server reads the session's own capability advertisement and reports it here,
 * so the client can present them as unavailable instead of offering editors
 * whose every save fails.
 *
 * `true` also covers "not known" — no mail backend configured, no linked
 * mailbox, an unreachable provider. Only a provider that positively does not
 * advertise the extension answers `false`.
 */
export const sieveCapabilitySchema = z.object({
  supported: z.boolean(),
});
export type SieveCapability = z.infer<typeof sieveCapabilitySchema>;

/**
 * Which of the two authors owns the Sieve script this server pushes (GH #23).
 *
 * - `rules`: the rule builder. The script is regenerated from `filter_rules`
 *   and `vacation_settings` on every change; the user never sees Sieve.
 * - `raw`: a script the user wrote by hand. It is pushed VERBATIM, and the
 *   rules and vacation settings — which are still stored, still listed and
 *   still editable — stop being applied until the user hands ownership back.
 *
 * There is deliberately no third "merged" mode. RFC 5228 §3.2 requires every
 * `require` to precede every other command, so splicing a regenerated block
 * into a hand-written script means hoisting and merging the two `require`
 * lists — i.e. parsing arbitrary Sieve, a parser this project does not have and
 * should not grow to keep a delimiter comment honest. One author at a time, an
 * explicit handover, and the hand-written script is never discarded by it.
 */
export const sieveScriptModeSchema = z.enum(["rules", "raw"]);
export type SieveScriptMode = z.infer<typeof sieveScriptModeSchema>;

/**
 * The advanced-mode state of one account (GH #23): which author owns the
 * script, and the hand-written script itself.
 *
 * `script` is what the user last saved, whether or not it is the active one.
 * Handing ownership back to the rule builder deactivates it and keeps the text,
 * so returning to advanced mode restores exactly what was written — losing a
 * hand-written script to a mode switch is the one outcome this feature must
 * never produce.
 */
export const sieveRawScriptSchema = z.object({
  mode: sieveScriptModeSchema,
  /** The stored hand-written script; `""` when one was never saved. */
  script: z.string(),
  /** When it was last written; null when nothing was ever saved. */
  updatedAt: z.string().nullable(),
});
export type SieveRawScript = z.infer<typeof sieveRawScriptSchema>;

/**
 * What the rule builder produces right now — the starting point an advanced
 * editor is seeded with, so taking over does not mean retyping the rules.
 *
 * Read on its own endpoint rather than as a field of the state above, because
 * producing it costs a JMAP session and a `Mailbox/get` (the trash folder's
 * real name), and the state is read on every Filters panel load while this is
 * only read when a user actually opens the advanced editor.
 */
export const sieveGeneratedScriptSchema = z.object({ script: z.string() });
export type SieveGeneratedScript = z.infer<typeof sieveGeneratedScriptSchema>;

/** Generous for a Sieve script; small enough that a paste accident is refused. */
const MAX_RAW_SCRIPT_CHARS = 65_536;

export const sieveRawScriptInputSchema = z.object({
  script: z
    .string()
    .max(MAX_RAW_SCRIPT_CHARS)
    // NUL cannot be stored in a Postgres `text` column. Nothing ELSE about the
    // script is touched: unlike the values the generator interpolates, this is
    // the user's own Sieve, and quietly rewriting it — stripping a control
    // character, trimming a line — is exactly what an advanced editor must not
    // do. Anything the mail server dislikes is the mail server's answer to
    // give, through SieveScript/validate.
    .refine((script) => !script.includes("\u0000"), { message: "script must not contain NUL" })
    // A blank script would deactivate filtering entirely, which is what handing
    // ownership back to the rule builder is for. Refusing it here means an
    // emptied textarea can never be the thing that discards a saved script.
    .refine((script) => script.trim() !== "", { message: "script required" }),
});
export type SieveRawScriptInput = z.infer<typeof sieveRawScriptInputSchema>;

export const vacationSettingsSchema = z.object({
  enabled: z.boolean(),
  subject: z.string(),
  message: z.string(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  intervalDays: z.number().int(),
});
export type VacationSettings = z.infer<typeof vacationSettingsSchema>;

export const vacationSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    subject: singleLine(200).default(""),
    message: z.string().max(5000).default(""),
    startsAt: isoDate.nullable().default(null),
    endsAt: isoDate.nullable().default(null),
    intervalDays: z.number().int().min(1).max(60).default(7),
  })
  .refine((value) => !value.enabled || value.message.trim().length > 0, {
    message: "message required when enabled",
    path: ["message"],
  })
  .refine(
    (value) =>
      value.startsAt === null || value.endsAt === null || value.startsAt <= value.endsAt,
    { message: "endsAt must not be before startsAt", path: ["endsAt"] },
  );
export type VacationSettingsInput = z.infer<typeof vacationSettingsInputSchema>;
