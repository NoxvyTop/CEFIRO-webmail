import { z } from "zod";

/**
 * One of the caller's own active sessions, as listed by
 * `GET /api/auth/sessions` (#302).
 *
 * `id` is the session's opaque handle — the SHA-256 hash the server already
 * stores as the row's primary key, NOT the session token. It cannot be used to
 * authenticate (the middleware hashes the presented cookie and compares, so it
 * needs the token's preimage, which this is not) and every revocation is scoped
 * to the caller's own `user_id`, so it is safe to hand back and use only as a
 * revoke target. The raw token stays hashed at rest and is never exposed.
 *
 * `userAgent` and `ip` are captured best-effort at login and are the caller's
 * OWN metadata — the same person who created these sessions is the only one who
 * can read them — so they are shown to help recognise a device, not exposed more
 * widely (privacy note in #302). Either may be null when it could not be
 * attributed. Timestamps are ISO strings so the value a client parses never
 * depends on the server's locale (same discipline as the sieve-sync-state repo).
 */
export const activeSessionSchema = z.object({
  id: z.string(),
  /** Whether this row is the session making the request. */
  current: z.boolean(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
});
export type ActiveSession = z.infer<typeof activeSessionSchema>;

export const activeSessionListSchema = z.array(activeSessionSchema);
