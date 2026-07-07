import { Hono } from "hono";
import {
  filterOrderSchema,
  filterRuleInputSchema,
  vacationSettingsInputSchema,
} from "@webmail/shared";
import { DomainError } from "../../core/errors";
import type { FilterRulesRepo } from "../../infra/repos/filter-rules";
import type { VacationSettingsRepo } from "../../infra/repos/vacation-settings";
import { requireSession } from "../auth/middleware";
import type { MailDeps, MailVariables } from "../mail/context";
import { syncSieveScript } from "./sync";

export type SieveDeps = {
  sessions: MailDeps["sessions"];
  mailCredentials: MailDeps["mailCredentials"];
  filterRules: FilterRulesRepo;
  vacationSettings: VacationSettingsRepo;
  jmap: MailDeps["jmap"];
};

type SyncOutcome = "ok" | "skipped" | "failed" | "invalid";

async function trySync(
  deps: SieveDeps,
  user: { userId: string; email: string },
): Promise<SyncOutcome> {
  if (!deps.jmap) return "skipped";
  let password: string | null;
  try {
    password = await deps.mailCredentials.get(user.userId);
  } catch {
    return "failed";
  }
  if (password === null) return "skipped";
  try {
    const auth = { email: user.email, password };
    const session = await deps.jmap.getSession(auth);
    const [rules, vacation] = await Promise.all([
      deps.filterRules.list(user.userId),
      deps.vacationSettings.get(user.userId),
    ]);
    await syncSieveScript({ jmap: deps.jmap, auth, session, rules, vacation });
    return "ok";
  } catch (error) {
    if (error instanceof DomainError && error.code === "sieve_invalid") {
      return "invalid";
    }
    return "failed";
  }
}

export function createSieveRouter(deps: SieveDeps) {
  const router = new Hono<{ Variables: MailVariables }>();

  router.use("*", requireSession(deps.sessions));

  router.get("/filters", async (c) => {
    const user = c.get("user");
    return c.json(await deps.filterRules.list(user.userId));
  });

  router.post("/filters/sync", async (c) => {
    const user = c.get("user");
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      const code = outcome === "invalid" ? "sieve_invalid" : "sieve_sync_failed";
      return c.json({ code, message: `errors.${code}`, traceId: c.get("traceId") }, 502);
    }
    return c.json({ status: outcome });
  });

  router.put("/filters/order", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = filterOrderSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const reordered = await deps.filterRules.reorder(user.userId, parsed.data.ids);
    if (!reordered) {
      return c.json(
        { code: "invalid_order", message: "errors.invalid_order", traceId: c.get("traceId") },
        400,
      );
    }
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      const code = outcome === "invalid" ? "sieve_invalid" : "sieve_sync_failed";
      return c.json({ code, message: `errors.${code}`, traceId: c.get("traceId") }, 502);
    }
    return c.json({ ok: true });
  });

  router.post("/filters", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = filterRuleInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const created = await deps.filterRules.create(user.userId, parsed.data);
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      const code = outcome === "invalid" ? "sieve_invalid" : "sieve_sync_failed";
      return c.json({ code, message: `errors.${code}`, traceId: c.get("traceId") }, 502);
    }
    return c.json(created);
  });

  router.put("/filters/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = filterRuleInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const updated = await deps.filterRules.update(user.userId, id, parsed.data);
    if (!updated) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      const code = outcome === "invalid" ? "sieve_invalid" : "sieve_sync_failed";
      return c.json({ code, message: `errors.${code}`, traceId: c.get("traceId") }, 502);
    }
    return c.json(updated);
  });

  router.delete("/filters/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const removed = await deps.filterRules.remove(user.userId, id);
    if (!removed) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      const code = outcome === "invalid" ? "sieve_invalid" : "sieve_sync_failed";
      return c.json({ code, message: `errors.${code}`, traceId: c.get("traceId") }, 502);
    }
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
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = vacationSettingsInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const saved = await deps.vacationSettings.set(user.userId, parsed.data);
    const outcome = await trySync(deps, user);
    if (outcome === "failed" || outcome === "invalid") {
      const code = outcome === "invalid" ? "sieve_invalid" : "sieve_sync_failed";
      return c.json({ code, message: `errors.${code}`, traceId: c.get("traceId") }, 502);
    }
    return c.json(saved);
  });

  return router;
}

export type SieveRouter = ReturnType<typeof createSieveRouter>;
