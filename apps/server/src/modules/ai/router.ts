import { Hono, type MiddlewareHandler } from "hono";
import { draftInputSchema, isQuoteSeparatorLine } from "@webmail/shared";
import { errorResponse } from "../../core/error-response";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";
import { createRateLimiter, type RateLimiter } from "../../core/rate-limit";
import { requireSession } from "../auth/middleware";
import { requireMail } from "../mail/context";
import type { AiDeps, AiVariables } from "./context";

// Per-user quota for the paid-LLM endpoints (GH #194). Keyed by userId, NOT IP,
// so one busy office behind a single NAT isn't throttled as a whole while an
// individual account still can't burn unbounded provider spend. 20/min/user is
// well above interactive use (summarize a message, draft a reply) yet caps a
// scripted account long before the bill runs away; the window is short so a
// legitimate user is unblocked within a minute.
const AI_MAX_REQUESTS_PER_USER = 20;
const AI_RATE_WINDOW_MS = 60_000;

// Bounds on the total input handed to a thread summary (GH #195). The route
// caps each message BODY at 512 KB via JMAP's maxBodyValueBytes, but nothing
// capped the message COUNT, so a long thread produced a prompt of N × 512 KB —
// runaway cost and provider context-window errors. Keep the most recent
// messages (they carry the current state of the conversation) within a bounded
// character budget; anything dropped/truncated is logged, never silently cut.
const MAX_THREAD_SUMMARY_MESSAGES = 40;
const MAX_THREAD_SUMMARY_CHARS = 60_000;

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

/**
 * Per-user quota gate (GH #194). Placed AFTER requireAiEnabled so a disabled
 * server never burns a caller's budget, and keyed by userId so the limit is per
 * account rather than per IP. On over-limit: 429 with Retry-After and the
 * `ai_rate_limited` code, refused before any JMAP fetch or provider call.
 */
function requireAiQuota(limiter: RateLimiter): MiddlewareHandler<{ Variables: AiVariables }> {
  return async (c, next) => {
    const gate = limiter.check(c.get("user").userId);
    if (!gate.allowed) {
      c.header("Retry-After", String(gate.retryAfterSeconds));
      return errorResponse(c, "ai_rate_limited", 429);
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
 * Strips the dragged quoted-reply trail from a message body so thread
 * summarization only sees what this particular message actually says, not
 * the previous messages it re-quotes. Truncates at the first line that looks
 * like a client-inserted reply separator (see isQuoteSeparatorLine, shared
 * with the reader's own quote split — GH #168), then drops any remaining
 * `>`-quoted lines (top-posted quote blocks sometimes have no separator line
 * at all).
 */
export function stripQuotedTrail(text: string): string {
  const lines = text.split("\n");
  const cutIndex = lines.findIndex(isQuoteSeparatorLine);
  const kept = cutIndex === -1 ? lines : lines.slice(0, cutIndex);
  return kept
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n")
    .trim();
}

export type ThreadSummaryMessage = { from: string; body: string };

export type CapThreadResult = {
  messages: ThreadSummaryMessage[];
  truncated: boolean;
  /** How many whole messages were dropped to fit the count cap. */
  droppedMessages: number;
  /** How many characters were trimmed to fit the character budget. */
  droppedChars: number;
};

/**
 * Bounds the input to a thread summary (GH #195). Keeps the MOST RECENT
 * messages — the tail of a conversation carries its current state and pending
 * items — first honoring `maxMessages`, then a total-character budget applied
 * from the newest message backward. The oldest kept message is truncated (not
 * dropped) when only part of it fits, and the returned list stays in
 * chronological order. Pure and exported so the cap is unit-tested directly and
 * the route only has to log what it reports.
 */
export function capThreadMessages(
  messages: ThreadSummaryMessage[],
  limits: { maxMessages: number; maxChars: number },
): CapThreadResult {
  const droppedMessages = Math.max(0, messages.length - limits.maxMessages);
  const kept = droppedMessages > 0 ? messages.slice(-limits.maxMessages) : [...messages];

  // Fill the character budget from the newest message backward.
  const bounded: ThreadSummaryMessage[] = [];
  let remaining = limits.maxChars;
  let droppedChars = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    const message = kept[i]!;
    if (remaining <= 0) {
      // No budget left even for this whole message → drop it entirely.
      droppedChars += message.body.length;
      continue;
    }
    if (message.body.length <= remaining) {
      bounded.unshift(message);
      remaining -= message.body.length;
    } else {
      droppedChars += message.body.length - remaining;
      bounded.unshift({ from: message.from, body: message.body.slice(0, remaining) });
      remaining = 0;
    }
  }

  return {
    messages: bounded,
    truncated: droppedMessages > 0 || droppedChars > 0,
    droppedMessages,
    droppedChars,
  };
}

type JmapThreadEmailAddress = { name?: string | null; email: string };

type JmapThreadEmail = JmapEmailBody & {
  from?: JmapThreadEmailAddress[];
  receivedAt?: string;
};

type JmapThread = { id: string; emailIds: string[] };

/** "Name <email>" when a display name is present, otherwise just the email. */
function formatSender(from: JmapThreadEmailAddress[] | undefined): string {
  const first = from?.[0];
  if (!first) return "";
  return first.name ? `${first.name} <${first.email}>` : first.email;
}

/**
 * Router for the AI features (summarize / draft-with-AI). Both routes fail
 * fast with `ai_disabled` when deps.aiClient is null (software-level gate is
 * off) — no JMAP call and no provider call is attempted in that case.
 */
export function createAiRouter(deps: AiDeps) {
  const router = new Hono<{ Variables: AiVariables }>();
  // One limiter per router instance, living in this closure so its per-user
  // counters persist across requests. Injectable so tests drive a small limit.
  const aiRateLimiter =
    deps.aiRateLimiter ??
    createRateLimiter({ limit: AI_MAX_REQUESTS_PER_USER, windowMs: AI_RATE_WINDOW_MS });
  const quota = requireAiQuota(aiRateLimiter);

  router.use("*", requireSession(deps.sessions));

  router.post("/messages/:id/summarize", requireAiEnabled(deps), quota, requireMail(deps), async (c) => {
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
      return errorResponse(c, "not_found", 404);
    }
    const bullets = await deps.aiClient!.summarize(extractBodyText(email));
    return c.json({ bullets });
  });

  // Thread/conversation summary (GH #116): the single-message route above
  // stays as-is for standalone messages — the reader picks between the two
  // client-side based on the thread's message count. This route fetches
  // every message in the thread (same Thread/get -> Email/get chained
  // pattern as GET /threads/:threadId in modules/mail/router.ts), strips
  // each message's dragged quote trail so the previous messages aren't
  // double-counted, and asks for one conversation-level summary.
  //
  // Note on token cost: a long thread means more input tokens (no
  // truncation is applied here) — acceptable for now, revisit if long
  // threads become a cost/latency problem in practice.
  router.post("/threads/:threadId/summarize", requireAiEnabled(deps), quota, requireMail(deps), async (c) => {
    const threadId = c.req.param("threadId");
    const session = c.get("jmapSession");
    const responses = await deps.jmap!.request(c.get("jmapAuth"), session, [
      ["Thread/get", { accountId: session.accountId, ids: [threadId] }, "t"],
      [
        "Email/get",
        {
          accountId: session.accountId,
          "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
          properties: ["id", "from", "receivedAt", "textBody", "htmlBody", "bodyValues"],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: 524288,
        },
        "g",
      ],
    ]);

    const threadResult = (responses[0]?.[1] ?? {}) as { list?: JmapThread[] };
    const getResult = (responses[1]?.[1] ?? {}) as { list?: JmapThreadEmail[] };
    const emails = getResult.list ?? [];
    if (threadResult.list?.length === 0 || emails.length === 0) {
      return errorResponse(c, "not_found", 404);
    }

    const ordered = [...emails].sort(
      (a, b) => Date.parse(a.receivedAt ?? "") - Date.parse(b.receivedAt ?? ""),
    );
    const messages = ordered.map((email) => ({
      from: formatSender(email.from),
      body: stripQuotedTrail(extractBodyText(email)),
    }));

    // Bound the total prompt before the paid provider call (GH #195). No email
    // content is logged — only the counts — so the truncation is observable
    // without leaking bodies (see core/ai.ts privacy discipline).
    const capped = capThreadMessages(messages, {
      maxMessages: MAX_THREAD_SUMMARY_MESSAGES,
      maxChars: MAX_THREAD_SUMMARY_CHARS,
    });
    if (capped.truncated) {
      log("warn", "thread summary input truncated", {
        traceId: c.get("traceId"),
        threadId,
        totalMessages: messages.length,
        keptMessages: capped.messages.length,
        droppedMessages: capped.droppedMessages,
        droppedChars: capped.droppedChars,
      });
    }

    const bullets = await deps.aiClient!.summarizeThread(capped.messages);
    return c.json({ bullets });
  });

  router.post("/compose/draft", requireAiEnabled(deps), quota, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, "invalid_body", 400);
    }
    const parsed = draftInputSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, "invalid_body", 400);
    }
    const draft = await deps.aiClient!.draftReply(parsed.data.subject);
    return c.json({ body: draft });
  });

  return router;
}

export type AiRouter = ReturnType<typeof createAiRouter>;
