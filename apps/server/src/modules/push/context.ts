import type { PushSender } from "../../core/push";
import type { RateLimiter } from "../../core/rate-limit";
import type { PushSubscriptionsRepo } from "../../infra/repos/push-subscriptions";
import type { AuthVariables } from "../auth/middleware";
import type { SessionStore } from "../auth/sessions";

// pushClient is null whenever the feature is off (no VAPID keys configured) —
// same "null adapter means not configured" convention as MailDeps.jmap and
// AiDeps.aiClient. Routes that do real work check for null and fail fast with
// `push_disabled` before touching anything.
export type PushDeps = {
  sessions: SessionStore;
  pushSubscriptions: PushSubscriptionsRepo;
  pushClient: PushSender | null;
  // The VAPID public key the SPA needs to subscribe. Set together with
  // pushClient (both come from the same configured trio), so it is present
  // exactly when the feature is enabled and null otherwise.
  vapidPublicKey: string | null;
  // Per-user quota over the subscribe/unsubscribe writes. Injectable so tests
  // drive a small limit; a default is created in the router when absent.
  pushRateLimiter?: RateLimiter;
};

export type PushVariables = AuthVariables;
