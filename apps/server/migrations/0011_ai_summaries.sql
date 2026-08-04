-- #307: server-side cache of AI summaries. Generating a summary hits a paid LLM
-- provider, so a repeat request for the SAME content must return the stored
-- bullets WITHOUT calling the provider again — leaving and re-entering the app
-- (or re-opening a message) should not re-bill the account.
--
-- One row per (user, kind, target, content). `kind` distinguishes a single
-- `message` summary from a whole-`thread` summary. `target_id` is the JMAP email
-- id (message) or thread id (thread) — the thing the user asked to summarize.
--
-- `content_key` is what makes the cache stale-safe. A message body is immutable,
-- so for messages the key equals `target_id`. A thread can GROW, so for threads
-- the key is a hash of the ordered email ids (see threadContentKey in
-- modules/ai/router.ts): a new message changes the id set → a different key → a
-- cache miss → a fresh summary, never a stale one. It is a separate column (not
-- folded into a single "key") so the same target can hold several historical
-- entries — a thread that grew keeps its old summary rows harmlessly.
--
-- `bullets` is the summary itself (a jsonb array of strings, same shape the
-- AiClient returns and the reader renders). Nothing here is logged: the bullets
-- and any email content stay out of the logs (see core/ai.ts privacy
-- discipline) — this table is the only place a summary is persisted.
--
-- The unique key IS the lookup index: every read filters on all four columns in
-- exactly this leading order (get(userId, kind, targetId, contentKey)), so the
-- unique constraint's composite btree fully serves it — no separate index is
-- added (same reasoning as push_subscriptions' `endpoint`).
create table email_ai_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('message', 'thread')),
  target_id text not null,
  content_key text not null,
  bullets jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, kind, target_id, content_key)
);
