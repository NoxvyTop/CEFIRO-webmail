-- #302: per-session metadata so a user can SEE their active sessions/devices and
-- revoke one individually (not only the global break-glass revoke, #302 body).
--
-- `user_agent` is the browser's User-Agent captured best-effort at login, and
-- `ip` is the client address attributed the SAME way the audit `ip` column is —
-- by counting TRUSTED_PROXY_HOPS from the right of X-Forwarded-For (see
-- core/client-ip.ts), never the raw caller-supplied header. Both are nullable:
-- a login where neither could be attributed (no header, an unattributable
-- proxy chain, a direct-socket test) stores null rather than a guessed value.
--
-- Both are only ever shown back to the SAME user who created the session — the
-- devices list is a person reading their own logins — so this exposes nothing
-- more widely than the audit log already records (privacy note in #302). The
-- session TOKEN stays hashed at rest (the `id` primary key is its SHA-256) and
-- is never stored or exposed in plaintext; nothing here changes that.
--
-- `created_at` (first seen) and `last_seen_at` (last activity) already exist
-- (0001 and 0012) and complete the row the devices list renders.
alter table sessions add column user_agent text;
alter table sessions add column ip text;
