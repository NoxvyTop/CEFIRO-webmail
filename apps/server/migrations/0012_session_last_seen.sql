-- #301: idle / sliding session timeout on top of the absolute TTL. The session
-- had only an ABSOLUTE expiry (`expires_at`, from SESSION_TTL_HOURS): a cookie
-- was valid for the full window even if it was never used, so a stolen one kept
-- serving until that ceiling. `last_seen_at` is refreshed on every
-- authenticated request (requireSession → sessions.findUser) and, when
-- SESSION_IDLE_MINUTES is set, a session idle beyond that window is treated as
-- expired — shrinking the useful life of a stolen cookie. `expires_at` stays the
-- non-extensible ceiling; the idle window only ever expires a session sooner,
-- never extends it past `expires_at`.
--
-- `not null default now()` backfills every existing row to "seen just now", so
-- no live session is treated as idle-expired the moment this migration runs.
alter table sessions add column last_seen_at timestamptz not null default now();

-- The idle sweep reads `last_seen_at` for a single session by primary key on
-- each request (findUser), which the `id` primary key already serves; no extra
-- index is added here. The one range scan over it — the opportunistic purge in
-- sessions.create — still filters on `expires_at`, which keeps its own index
-- (sessions_expires_at_idx, 0001).
