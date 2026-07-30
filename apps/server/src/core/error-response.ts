import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiError } from "@webmail/shared";
import { levelForStatus } from "./access-log";
import { log } from "./logger";

/**
 * The slice of a Hono context this helper needs. Structural on purpose: the
 * routers run under half a dozen different Variables types (AuthVariables,
 * MailVariables, ContactsVariables, the bare `{ traceId }` of the setup
 * router, and the untyped context Hono's bodyLimit hands its onError), and
 * none of them should have to be threaded through a generic just to build an
 * error body.
 */
type ErrorContext = {
  get(key: "traceId"): string | undefined;
  json(body: ApiError, status: ContentfulStatusCode): Response;
};

/**
 * The single place an error envelope is built — and, crucially, the single
 * place one is logged.
 *
 * Before GH #166 this body was written out by hand at ~97 call sites, every
 * one of them a plain `return c.json(...)` that never reaches `app.onError`.
 * The client got a traceId that appeared in no log line at all. Going through
 * here means the error *code* — not just the status the access log already
 * records — is greppable by that traceId.
 *
 * Argument order mirrors DomainError(code, httpStatus, messageKey) so the two
 * ways this codebase reports a failure read the same. `messageKey` defaults to
 * `errors.<code>`, which is what every call site but a handful already used.
 */
export function errorResponse(
  c: ErrorContext,
  code: string,
  status: ContentfulStatusCode,
  messageKey: string = `errors.${code}`,
): Response {
  // "unknown" rather than an absent field: ApiError requires a string, and a
  // context without the global middleware (a router mounted bare in a test)
  // must still produce an envelope the client can parse. Matches what
  // app.onError has always done.
  const traceId = c.get("traceId") ?? "unknown";
  log(levelForStatus(status), "error response", { traceId, code, status });
  return c.json({ code, message: messageKey, traceId }, status);
}
