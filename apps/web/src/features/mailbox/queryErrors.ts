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
