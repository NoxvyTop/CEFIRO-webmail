import { Hono, type MiddlewareHandler } from "hono";
import { draftInputSchema } from "@webmail/shared";
import { DomainError } from "../../core/errors";
import { requireSession } from "../auth/middleware";
import { requireMail } from "../mail/context";
import type { AiDeps, AiVariables } from "./context";

/**
 * Fails fast with `ai_disabled` before anything else runs — in particular
 * before requireMail gets a chance to reach out to JMAP. This is what
 * guarantees "disabled config → no network attempt" for the summarize route.
 */
function requireAiEnabled(deps: AiDeps): MiddlewareHandler<{ Variables: AiVariables }> {
  return async (_c, next) => {
    if (!deps.aiClient) {
      throw new DomainError("ai_disabled", 501, "errors.ai_disabled");
    }
    await next();
  };
}

type JmapEmailBody = {
  id: string;
  textBody?: { partId: string; type?: string | null }[];
  htmlBody?: { partId: string; type?: string | null }[];
  bodyValues?: Record<string, { value: string }>;
};

function concatBodyValues(
  parts: { partId: string }[] | undefined,
  bodyValues: Record<string, { value: string }> | undefined,
): string {
  return (parts ?? [])
    .map((part) => bodyValues?.[part.partId]?.value)
    .filter((value): value is string => value !== undefined)
    .join("");
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Extracts the best-effort plain text body of a message for the AI prompt. */
function extractBodyText(email: JmapEmailBody): string {
  const text = concatBodyValues(email.textBody, email.bodyValues);
  if (text) return text;
  const html = concatBodyValues(email.htmlBody, email.bodyValues);
  return html ? stripHtml(html) : "";
}

/**
 * Router for the AI features (summarize / draft-with-AI). Both routes fail
 * fast with `ai_disabled` when deps.aiClient is null (software-level gate is
 * off) — no JMAP call and no provider call is attempted in that case.
 */
export function createAiRouter(deps: AiDeps) {
  const router = new Hono<{ Variables: AiVariables }>();

  router.use("*", requireSession(deps.sessions));

  router.post("/messages/:id/summarize", requireAiEnabled(deps), requireMail(deps), async (c) => {
    const id = c.req.param("id");
    const session = c.get("jmapSession");
    const responses = await deps.jmap!.request(c.get("jmapAuth"), session, [
      [
        "Email/get",
        {
          accountId: session.accountId,
          ids: [id],
          properties: ["id", "textBody", "htmlBody", "bodyValues"],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: 524288,
        },
        "g",
      ],
    ]);
    const list = ((responses[0]?.[1] ?? {}) as { list?: JmapEmailBody[] }).list ?? [];
    const email = list[0];
    if (!email) {
      return c.json(
        { code: "not_found", message: "errors.not_found", traceId: c.get("traceId") },
        404,
      );
    }
    const bullets = await deps.aiClient!.summarize(extractBodyText(email));
    return c.json({ bullets });
  });

  router.post("/compose/draft", requireAiEnabled(deps), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const parsed = draftInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { code: "invalid_body", message: "errors.invalid_body", traceId: c.get("traceId") },
        400,
      );
    }
    const draft = await deps.aiClient!.draftReply(parsed.data.subject);
    return c.json({ body: draft });
  });

  return router;
}

export type AiRouter = ReturnType<typeof createAiRouter>;
