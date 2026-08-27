-- #294 (delivery slice): Web Push subscriptions, one row per browser/device a
-- user has opted in from. There is no `on delete cascade` worry beyond the
-- user: a subscription belongs to exactly one user, and when that user is
-- removed their devices go with them.
--
-- `endpoint` is the push service's per-device URL and is globally unique — the
-- same browser re-subscribing yields the same endpoint, so it is the natural
-- key the repo upserts on (a device that re-subscribes must update its keys in
-- place, never accumulate duplicate rows). It is a `text` column, not capped:
-- FCM/Mozilla/Apple endpoints are long and their length is not ours to bound.
--
-- `p256dh` and `auth` are the subscription's own public key material, not
-- secrets of ours, so they are stored as-is (base64url text) rather than
-- encrypted like mail credentials — they are only useful to encrypt a payload
-- FOR this device and carry nothing that identifies the user.
--
-- `user_agent` is nullable and captured best-effort, for the future per-device
-- "devices" list that folds into the session-hardening work (#302).
--
-- `last_seen_at` is refreshed on every re-subscribe so a stale-device cleanup
-- has something to sort on later; `created_at` records the first opt-in.
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- The hot lookup is "every subscription for this user", done on each delivery
-- and on the settings screen; the unique constraint already indexes `endpoint`.
create index push_subscriptions_user_id_idx on push_subscriptions (user_id);
