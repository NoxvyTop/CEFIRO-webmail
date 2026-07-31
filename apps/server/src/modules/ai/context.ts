import type { AiClient } from "../../core/ai";
import type { RateLimiter } from "../../core/rate-limit";
import type { JmapAccessDeps, MailVariables } from "../mail/context";
import type { SessionStore } from "../auth/sessions";

// aiClient is null whenever the software-level gate is off (AI_ENABLED=false
// or AI_API_KEY absent) — same "null adapter means not configured" convention
// as MailDeps.jmap (apps/server/src/modules/mail/context.ts). Routes must
// check for null and fail fast with `ai_disabled` before doing anything else,
// in particular before touching JMAP.
export type AiDeps = JmapAccessDeps & {
  sessions: SessionStore;
  aiClient: AiClient | null;
  fetchFn?: typeof fetch;
  // Per-user quota over the paid-LLM endpoints (GH #194). Injectable so tests
  // drive a small limit; a default is created in the router when absent.
  aiRateLimiter?: RateLimiter;
};

export type AiVariables = MailVariables;
