import { errorMessageKey } from "../../app/errorMessages";
import { MailApiError } from "./api";

// GH #215: this used to keep its own two-entry allowlist of codes, which left
// eight `mail.errors.*` messages that already existed unreachable — every other
// code fell to the generic message even when a specific one was sitting right
// there in the locale files. Resolution now goes through the one shared
// code → key map, whose source of truth is the translation bundle itself.
export function mailErrorKey(error: unknown): string {
  return errorMessageKey("mail", error instanceof MailApiError ? error.code : null);
}

// GH #345: 502 (Bad Gateway), 503 (Service Unavailable) and 504 (Gateway
// Timeout) are the statuses a JMAP provider restart or an upstream blip
// actually returns. Before this, 502/504 got the DEFAULT 3-retry allowance
// below while 503 — arguably the most transient of the three — got zero and
// failed immediately on the first hiccup. All three now share one bounded
// allowance instead.
const UPSTREAM_RETRYABLE_STATUSES = new Set([502, 503, 504]);
const UPSTREAM_RETRY_LIMIT = 2;

export function mailRetry(failureCount: number, error: unknown): boolean {
  if (!(error instanceof MailApiError)) return failureCount < 3;
  if (UPSTREAM_RETRYABLE_STATUSES.has(error.status)) return failureCount < UPSTREAM_RETRY_LIMIT;
  if (error.status >= 400 && error.status < 500) return false;
  return failureCount < 3;
}

// Short, capped exponential backoff — noticeably shorter than React Query's
// default (1s/2s/4s...) on purpose: a mailbox screen sitting on a spinner for
// several extra seconds is worse UX than a slightly less patient retry, and
// with only UPSTREAM_RETRY_LIMIT (2) attempts to make, the total added wait
// stays well under a second either way.
export function mailRetryDelay(failureCount: number): number {
  return Math.min(100 * 2 ** failureCount, 400);
}

// mail_credentials_missing is an onboarding state (the user's mailbox was
// never linked to a credential), not a server error — callers use this to
// pick the branded empty state over the generic role="alert" treatment.
export function isUnlinkedMailboxError(error: unknown): boolean {
  return error instanceof MailApiError && error.code === "mail_credentials_missing";
}
