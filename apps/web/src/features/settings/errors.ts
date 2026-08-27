import { errorMessageKey } from "../../app/errorMessages";
import { MailApiError } from "../mailbox/api";

// GH #255: this used to carry its own hand-maintained KNOWN_CODES allowlist —
// the pattern #215 removed from `mail` and `composer` precisely because a
// second list beside the translation bundle rots: adding a
// `settings.errors.<code>` message did nothing until somebody remembered to
// add the code here too, and the message stayed unreachable in the meantime.
// Resolution now goes through the one shared code → key map, whose source of
// truth is the bundle itself.
export function settingsErrorKey(error: unknown): string {
  return errorMessageKey("settings", error instanceof MailApiError ? error.code : null);
}
