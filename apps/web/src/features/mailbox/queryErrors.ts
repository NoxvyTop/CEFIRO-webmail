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
