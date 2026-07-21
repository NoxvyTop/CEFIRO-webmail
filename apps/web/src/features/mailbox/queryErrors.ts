import { MailApiError } from "./api";

const KNOWN_CODES = new Set(["mail_not_configured", "mail_credentials_missing"]);

export function mailErrorKey(error: unknown): string {
  if (error instanceof MailApiError && KNOWN_CODES.has(error.code)) {
    return `mail.errors.${error.code}`;
  }
  return "mail.errors.generic";
}

export function mailRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof MailApiError && (error.status === 503 || (error.status >= 400 && error.status < 500))) {
    return false;
  }
  return failureCount < 3;
}

// mail_credentials_missing is an onboarding state (the user's mailbox was
// never linked to a credential), not a server error — callers use this to
// pick the branded empty state over the generic role="alert" treatment.
export function isUnlinkedMailboxError(error: unknown): boolean {
  return error instanceof MailApiError && error.code === "mail_credentials_missing";
}
