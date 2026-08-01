import { errorMessageKey } from "../../app/errorMessages";
import { MailApiError } from "../mailbox/api";

/**
 * The message key for a failed admin-console action (GH #46).
 *
 * The console collapsed every failure into a single "the action could not be
 * completed", so the three 409 guardrails the hardening added — `self_demotion`,
 * `self_archive`, `last_admin` — refused the action without ever saying why.
 * A guardrail whose whole value is explaining the block is worth very little
 * silent, and an admin who is told nothing retries or goes looking for a bug.
 *
 * Resolution goes through the shared bundle-backed map (GH #215/#255), so this
 * is not another allowlist to keep in step with the server: a code lights up the
 * moment `admin.errors.<code>` exists in the locale files, and anything without
 * one still lands on `admin.errors.generic` rather than on a raw key.
 */
export function adminErrorKey(error: unknown): string {
  return errorMessageKey("admin", error instanceof MailApiError ? error.code : null);
}
