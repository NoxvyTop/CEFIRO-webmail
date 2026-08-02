import { Hono } from "hono";
import {
  filterOrderSchema,
  filterRuleInputSchema,
  sieveRawScriptInputSchema,
  vacationSettingsInputSchema,
} from "@webmail/shared";
import { errorResponse } from "../../core/error-response";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";
import type { FilterRulesRepo } from "../../infra/repos/filter-rules";
import type { SieveRawScriptRepo } from "../../infra/repos/sieve-raw-script";
import type { SieveSyncStateRepo } from "../../infra/repos/sieve-sync-state";
import type { VacationSettingsRepo } from "../../infra/repos/vacation-settings";
import { requireSession } from "../auth/middleware";
import type { JmapAuth, JmapClient, JmapSession } from "../../infra/jmap/client";
import type { MailDeps, MailVariables } from "../mail/context";
import { generateSieveScript } from "./generator";
import {
  DEFAULT_TRASH_FOLDER,
  resolveTrashFolder,
  supportsSieve,
  syncSieveScript,
  uploadAndValidateScript,
} from "./sync";

// How long a reconcile attempt waits before it may be retried on read (GH
// #221). Without it, a settings page polling the state while Stalwart is down
// would turn one poll into one outbound push each — the amplification pattern
// GH #220 closed on /api/health. A minute is short enough that a user who fixed
// their mail server sees filters applied without touching anything, and long
// enough that polling costs nothing.
const DEFAULT_RECONCILE_COOLDOWN_MS = 60_000;

export type SieveDeps = {
  sessions: MailDeps["sessions"];
  mailCredentials: MailDeps["mailCredentials"];
  filterRules: FilterRulesRepo;
  vacationSettings: VacationSettingsRepo;
  sieveSyncState: SieveSyncStateRepo;
  sieveRawScript: SieveRawScriptRepo;
  jmap: MailDeps["jmap"];
  /** Injectable so tests drive reconciliation without waiting; see above. */
  reconcileCooldownMs?: number;
};

type SyncOutcome = "ok" | "skipped" | "failed" | "invalid" | "unsupported";

async function trySync(
  deps: SieveDeps,
  user: { userId: string; email: string },
): Promise<SyncOutcome> {
  if (!deps.jmap) return "skipped";
  let password: string | null;
  try {
    password = await deps.mailCredentials.get(user.userId);
  } catch {
    log("warn", "sieve sync failed: credential decrypt error", { userId: user.userId });
    return "failed";
  }
  if (password === null) return "skipped";
  try {
    const auth = { email: user.email, password };
    const session = await deps.jmap.getSession(auth);
    // GH #36: checked BEFORE anything is pushed, so a provider without the
    // Sieve extension is never sent a request it is bound to reject. The
    // outcome is distinct from "failed" because it is not a transient one:
    // there is nothing here to retry, and the UI has to say so.
    if (!supportsSieve(session)) return "unsupported";
    const [rules, vacation, raw] = await Promise.all([
      deps.filterRules.list(user.userId),
      deps.vacationSettings.get(user.userId),
      // GH #23: which author owns the script. Read here rather than at each
      // call site so EVERY push goes through it — including the reconcile GH
      // #221 runs on read, which would otherwise quietly replace a
      // hand-written script with a regenerated one the next time the settings
      // page was opened.
      deps.sieveRawScript.get(user.userId),
    ]);
    await syncSieveScript({ jmap: deps.jmap, auth, session, rules, vacation, raw });
    return "ok";
  } catch (error) {
    if (error instanceof DomainError && error.code === "sieve_invalid") {
      log("warn", "sieve sync rejected: generated script invalid", { userId: user.userId });
      return "invalid";
    }
    const code = error instanceof DomainError ? error.code : "unexpected";
    log("warn", "sieve sync failed", { userId: user.userId, code });
    return "failed";
  }
}

/**
 * Pushes to Stalwart and records what Stalwart now enforces (GH #221).
 *
 * The local write and the push cannot share a transaction, so the outcome is
 * persisted instead: a rule that was saved but not applied stays visible as
 * such through GET /filters/sync-state rather than being silently forgotten
 * behind a 502 the user may never see again.
 */
async function syncAndRecord(
  deps: SieveDeps,
  user: { userId: string; email: string },
): Promise<SyncOutcome> {
  const outcome = await trySync(deps, user);
  const code = syncFailureCode(outcome);
  if (code) await deps.sieveSyncState.markFailed(user.userId, code);
  else if (outcome === "ok") await deps.sieveSyncState.markSynced(user.userId);
  // "skipped" is not success: mail is not configured for this user, so the
  // rules are stored and nothing is enforcing them. It is not a failure either
  // — there is no error to report and nothing to retry until mail works.
  else await deps.sieveSyncState.markPending(user.userId);
  return outcome;
}

/** The error code an outcome must be reported with, or null when it is not a failure. */
function syncFailureCode(outcome: SyncOutcome): string | null {
  if (outcome === "invalid") return "sieve_invalid";
  if (outcome === "failed") return "sieve_sync_failed";
  if (outcome === "unsupported") return "sieve_unsupported";
  return null;
}

/** Everything a JMAP call needs, once a session has actually been obtained. */
type OpenSession = { jmap: JmapClient; auth: JmapAuth; session: JmapSession };

/**
 * A live JMAP session for this user, or `null` when there is none to be had —
 * no mail backend configured, no credential linked, an undecryptable credential
 * row, a provider that will not answer.
 *
 * Every caller below treats `null` as "not known" rather than as an answer,
 * which is the reading GH #36 established: only a provider that positively says
 * something may take a feature away.
 */
async function openSession(
  deps: SieveDeps,
  user: { userId: string; email: string },
): Promise<OpenSession | null> {
  const jmap = deps.jmap;
  if (!jmap) return null;
  try {
    const password = await deps.mailCredentials.get(user.userId);
    if (password === null) return null;
    const auth = { email: user.email, password };
    return { jmap, auth, session: await jmap.getSession(auth) };
  } catch {
    return null;
  }
}

/**
 * Whether this user's JMAP provider advertises the Sieve extension (GH #36).
 *
 * Answers `true` for everything that is not a positive absence — no mail
 * backend configured, no credentials linked yet, a provider that cannot be
 * reached right now. Those are all "not known", and the two wrong answers are
 * not symmetric: a wrong `true` costs the same error the user already got
 * before this existed, while a wrong `false` would hide a working feature and
 * the rules already saved behind it.
 */
async function sieveSupported(
  deps: SieveDeps,
  user: { userId: string; email: string },
): Promise<boolean> {
  const opened = await openSession(deps, user);
  return opened === null || supportsSieve(opened.session);
}

/**
 * The script the rule builder produces right now (GH #23) — what the advanced
 * editor shows, and what a user taking the script over starts from.
 *
 * Best-effort on the trash folder: it is asked of the provider so the preview
 * matches the push byte for byte, and falls back to the same default
 * syncSieveScript uses when the provider lists no trash mailbox. The fallback
 * only shows in a preview taken while the provider is unreachable, and only for
 * an account whose rules use a `delete` action — and while the provider is
 * unreachable, nothing is being pushed anyway.
 */
async function generatedScriptFor(
  deps: SieveDeps,
  user: { userId: string; email: string },
): Promise<string> {
  const [rules, vacation, opened] = await Promise.all([
    deps.filterRules.list(user.userId),
    deps.vacationSettings.get(user.userId),
    openSession(deps, user),
  ]);
  let trashFolder = DEFAULT_TRASH_FOLDER;
  if (opened) {
    try {
      trashFolder = await resolveTrashFolder(opened);
    } catch {
      log("warn", "sieve preview: trash folder unresolved, using default", {
        userId: user.userId,
      });
    }
  }
  return generateSieveScript({ rules, vacation, trashFolder });
}

/**
 * Whether the provider's own parser refuses this hand-written script (GH #23),
 * asked BEFORE anything is stored.
 *
 * A rule-built script is generated by code that cannot produce a syntax error,
 * so the existing flow could afford to validate as part of the push. A
 * hand-written one is the opposite: a typo is the normal case, and storing it
 * first would park the account on `sieve_invalid` — the one sync failure GH
 * #221's model marks as never worth retrying — for a script the user could have
 * fixed on the spot.
 *
 * Answers `false` for everything it could not ask: no session, a provider
 * without the Sieve extension (GH #36 — never send it a request it is bound to
 * reject), a provider that is down. Refusing to save on "not known" would make
 * the editor unusable exactly when the user most needs it, and the push that
 * follows records the real outcome either way.
 */
async function rawScriptRejected(
  deps: SieveDeps,
  user: { userId: string; email: string },
  script: string,
): Promise<boolean> {
  const opened = await openSession(deps, user);
  if (!opened || !supportsSieve(opened.session)) return false;
  try {
    await uploadAndValidateScript({ ...opened, script });
    return false;
  } catch (error) {
    return error instanceof DomainError && error.code === "sieve_invalid";
  }
}

/** Whether an unapplied state is old enough to be worth another push. */
function reconcileDue(updatedAt: string | null, cooldownMs: number): boolean {
  if (updatedAt === null) return true;
  const at = Date.parse(updatedAt);
  return Number.isNaN(at) || Date.now() - at >= cooldownMs;
}

export function createSieveRouter(deps: SieveDeps) {
  const router = new Hono<{ Variables: MailVariables }>();
  const reconcileCooldownMs = deps.reconcileCooldownMs ?? DEFAULT_RECONCILE_COOLDOWN_MS;

  router.use("*", requireSession(deps.sessions));

  /**
   * Whether filters and vacation can work at all against this account's mail
   * provider (GH #36). Both features are one Sieve script, so they share one
   * answer, and the client asks before offering either — the alternative is
   * what this replaced: a full editor whose every save fails.
   */
  router.get("/sieve/capability", async (c) => {
    const user = c.get("user");
    return c.json({ supported: await sieveSupported(deps, user) });
  });

  router.get("/filters", async (c) => {
    const user = c.get("user");
    return c.json(await deps.filterRules.list(user.userId));
  });

  /**
   * Whether the filters this API lists are the ones Stalwart is actually
   * running (GH #221) — and the reconciliation point for when they are not.
   *
   * Reading this retries a push that was left unapplied, once per cooldown, so
   * an outage that ended repairs itself the next time the settings page is
   * opened instead of waiting for the user to guess that they must re-save a
   * rule. Rate-limited by the cooldown rather than unbounded: see above.
   */
  router.get("/filters/sync-state", async (c) => {
    const user = c.get("user");
    const state = await deps.sieveSyncState.get(user.userId);
    if (state.status === "synced" || !reconcileDue(state.updatedAt, reconcileCooldownMs)) {
      return c.json(state);
    }
    await syncAndRecord(deps, user);
    return c.json(await deps.sieveSyncState.get(user.userId));
  });

  router.post("/filters/sync", async (c) => {
    const user = c.get("user");
    const outcome = await syncAndRecord(deps, user);
    const code = syncFailureCode(outcome);
    if (code) return errorResponse(c, code, 502);
    return c.json({ status: outcome });
  });

  router.put("/filters/order", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = filterOrderSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    await deps.sieveSyncState.markPending(user.userId);
    const reordered = await deps.filterRules.reorder(user.userId, parsed.data.ids);
    if (!reordered) {
      return errorResponse(c, "invalid_order", 400);
    }
    const code = syncFailureCode(await syncAndRecord(deps, user));
    if (code) return errorResponse(c, code, 502);
    return c.json({ ok: true });
  });

  /**
   * The advanced mode (GH #23): which author owns the Sieve script, and the
   * script the user wrote by hand.
   *
   * Registered before `/filters/:id` for the same reason `/filters/order` is —
   * Hono matches in registration order, and `raw` would otherwise be read as a
   * rule id. Cheap on purpose: one primary-key select, because the Filters and
   * Vacation panels both read it on load to say whether what they show is
   * actually being applied.
   */
  router.get("/filters/raw", async (c) => {
    const user = c.get("user");
    return c.json(await deps.sieveRawScript.get(user.userId));
  });

  /**
   * What the rule builder produces right now — the advanced editor's starting
   * point. Separate from the state above because producing it costs a JMAP
   * session and a Mailbox/get, and only a user who actually opens the editor
   * should pay for it.
   */
  router.get("/filters/raw/generated", async (c) => {
    const user = c.get("user");
    return c.json({ script: await generatedScriptFor(deps, user) });
  });

  /**
   * Saves a hand-written script and makes it the one that runs.
   *
   * Saving IS the handover: there is no separate "activate" step to forget, so
   * a user cannot end up with a saved script that silently does nothing. What
   * the rule builder holds is left untouched and keeps being listed — it simply
   * stops being applied, which is what the UI has to say plainly and what
   * POST /filters/raw/rules undoes.
   *
   * 422 rather than 502 when the provider refuses the script: the mail server
   * is working fine and it is the submitted content that cannot run. Nothing is
   * stored in that case, so a typo never becomes the account's state.
   */
  router.put("/filters/raw", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = sieveRawScriptInputSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    // Before markPending, because a rejected script changes nothing and must
    // not leave the sync state claiming a drift that does not exist.
    if (await rawScriptRejected(deps, user, parsed.data.script)) {
      return errorResponse(c, "sieve_invalid", 422);
    }
    await deps.sieveSyncState.markPending(user.userId);
    const saved = await deps.sieveRawScript.save(user.userId, parsed.data.script);
    const code = syncFailureCode(await syncAndRecord(deps, user));
    if (code) return errorResponse(c, code, 502);
    return c.json(saved);
  });

  /**
   * Gives the script back to the rule builder.
   *
   * The hand-written script is KEPT, deactivated: this is the way back from the
   * handover above, and a way back that destroyed the user's work would not be
   * one. The next GET /filters/raw returns the same text, and saving it again
   * re-activates it unchanged.
   */
  router.post("/filters/raw/rules", async (c) => {
    const user = c.get("user");
    await deps.sieveSyncState.markPending(user.userId);
    const state = await deps.sieveRawScript.handBackToRules(user.userId);
    const code = syncFailureCode(await syncAndRecord(deps, user));
    if (code) return errorResponse(c, code, 502);
    return c.json(state);
  });

  router.post("/filters", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = filterRuleInputSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    // Marked before the write, not after: a crash between the two must leave a
    // state that overstates the drift, never one that hides it (GH #221).
    await deps.sieveSyncState.markPending(user.userId);
    const created = await deps.filterRules.create(user.userId, parsed.data);
    const code = syncFailureCode(await syncAndRecord(deps, user));
    if (code) return errorResponse(c, code, 502);
    return c.json(created);
  });

  router.put("/filters/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = filterRuleInputSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    await deps.sieveSyncState.markPending(user.userId);
    const updated = await deps.filterRules.update(user.userId, id, parsed.data);
    if (!updated) {
      return errorResponse(c, "not_found", 404);
    }
    const code = syncFailureCode(await syncAndRecord(deps, user));
    if (code) return errorResponse(c, code, 502);
    return c.json(updated);
  });

  router.delete("/filters/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    await deps.sieveSyncState.markPending(user.userId);
    const removed = await deps.filterRules.remove(user.userId, id);
    if (!removed) {
      return errorResponse(c, "not_found", 404);
    }
    const code = syncFailureCode(await syncAndRecord(deps, user));
    if (code) return errorResponse(c, code, 502);
    return c.json({ ok: true });
  });

  router.get("/vacation", async (c) => {
    const user = c.get("user");
    return c.json(await deps.vacationSettings.get(user.userId));
  });

  router.put("/vacation", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = vacationSettingsInputSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    await deps.sieveSyncState.markPending(user.userId);
    const saved = await deps.vacationSettings.set(user.userId, parsed.data);
    const code = syncFailureCode(await syncAndRecord(deps, user));
    if (code) return errorResponse(c, code, 502);
    return c.json(saved);
  });

  return router;
}

export type SieveRouter = ReturnType<typeof createSieveRouter>;
