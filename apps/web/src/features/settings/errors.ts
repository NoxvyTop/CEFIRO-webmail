import { MailApiError } from "../mailbox/api";

const KNOWN_CODES = new Set([
  "invalid_body",
  "invalid_order",
  "not_found",
  "sieve_invalid",
  "sieve_sync_failed",
]);

export function settingsErrorKey(error: unknown): string {
  if (error instanceof MailApiError && KNOWN_CODES.has(error.code)) {
    return `settings.errors.${error.code}`;
  }
  return "settings.errors.generic";
}
