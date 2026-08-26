-- GH #313: automatic opt-in copy delivery for shared mailboxes — the state the
-- background worker (apps/server/src/modules/mail/shared-copy/) needs to
-- follow a shared mailbox over time and to copy each new message to every
-- opted-in member exactly once.
--
-- THREE tables, deliberately separate, because they answer three different
-- questions: `shared_mailbox_copy_state` says where the ACCOUNT was last read
-- from (and who is delivering it right now), `shared_mailbox_member_state` says
-- from when each MEMBER is entitled to copies, and `shared_mailbox_copies` says
-- what has already been claimed or delivered for each (member, message). Each
-- is defined below, next to its own reasoning.
--
-- `shared_mailbox_copy_state` is the CURSOR: the last JMAP Email state of the
-- shared account this deployment has processed, one row per shared account.
-- The worker asks `Email/changes { sinceState }` from it and advances it only
-- after the copies for that page were attempted. Kept in Postgres rather than
-- in process memory because the cursor is what makes a restart safe: a worker
-- that forgot where it was would either re-baseline (and silently skip the
-- mail that arrived while it was down) or re-copy everything it can see. No
-- row means "never baselined", which the worker answers by recording the
-- current state WITHOUT copying — the opt-in is forward-looking, and historic
-- mail stays reachable through the manual copy button.
--
-- `shared_mailbox_copies` is the DEDUP LEDGER: one row per (member, shared
-- account, source email) a copy has been CLAIMED for, whatever became of it.
-- Advancing the cursor is not enough on its own, because a page's copies are
-- not atomic with the cursor write — a crash between the last Email/copy and
-- the cursor advance replays the page on the next cycle, and without this
-- ledger every member would get the page twice. The row is claimed BEFORE the
-- Email/copy and confirmed after it (see the `status` note further down, next
-- to the table itself), so a replay costs a query, never a duplicate. It is
-- keyed by the SOURCE id, not the copy's id, since the source is the only
-- thing both the changes feed and a replay agree on.
--
-- Deriving dedup from Stalwart instead (searching the member's inbox for the
-- copy) was considered and rejected: `Email/copy` mints a new id, the
-- Message-ID header is the only stable link and querying by it is neither
-- indexed nor guaranteed unique, and a member is free to delete the copy —
-- after which "is there a copy?" and "was a copy delivered?" stop agreeing.
--
-- `user_id` cascades with the user (a removed member has nothing left to
-- dedup); `shared_account_id` and `email_id` are opaque JMAP ids and carry no
-- foreign key — the accounts live in the provider, not here. There is no
-- retention of these rows and no purge of the copies they describe: both are
-- explicitly out of scope (docs/design/shared-mailboxes.md), and a ledger row
-- is a few dozen bytes per delivered message. The one deletion is the member
-- prune: a member who stops opting in loses their `pending` and `failed` rows
-- for that account along with their baseline, because those describe copies
-- that will now never be delivered. Their `copied` rows stay, since that is
-- the history which keeps a re-joiner from being sent the same mail twice.
--
-- The state row also carries the per-account delivery LEASE (`lease_owner`,
-- `lease_until`), which is what keeps two replicas from delivering the same
-- page. It replaced a transaction-scoped advisory lock: that lock held a
-- transaction open on one pooled connection for the WHOLE cycle while every
-- query of the cycle asked the pool for another one — a guaranteed deadlock at
-- DB_POOL_MAX=1 and a minutes-long idle-in-transaction connection otherwise,
-- and its `hashtext(accountId)` int4 key could collide between two unrelated
-- accounts. A lease is a row: taken with one atomic upsert, renewed after each
-- page, released in a `finally`, and self-healing after `lease_until` for a
-- replica that died mid-cycle. No transaction spans the cycle.
--
-- `email_state` is NULLABLE, and null means "never baselined": taking the
-- lease is what creates the row, so an account can legitimately have a lease
-- (and, later, a `last_cycle_at`) before it has a cursor.
--
-- `last_cycle_at` is INFORMATIONAL. It is stamped as soon as a cycle takes the
-- account's lease (and refreshed on every cursor advance), so it means "a cycle
-- was last attempted then" — including the runs that reached no member and the
-- ones that threw. Nothing decides anything from it: delivery always resumes
-- from `email_state`, however old it is. An age-based re-baseline used to sit
-- here and was removed, because the clock cannot tell an intentional pause from
-- an outage, a deploy, an account with no watcher or a swallowed cycle error —
-- and it answered all of them by dropping every message of the gap. A gap
-- DEFERS delivery (the backlog drains five pages a cycle); it never cancels it.
create table shared_mailbox_copy_state (
  shared_account_id text primary key,
  email_state text,
  last_cycle_at timestamptz,
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);

-- `shared_mailbox_member_state` is the PER-MEMBER baseline. The account cursor
-- answers "what is new in this mailbox"; it cannot answer "new since when for
-- THIS member", and using it for both handed a member who opted in today every
-- message that arrived since the account was first baselined — possibly months
-- of somebody else's mail, copied into their inbox in one burst.
--
-- `baselined_at` is WHEN the member was first seen opted into the account, and
-- the rule is a comparison: a member receives a message only if the shared
-- mailbox received it (`Email` `receivedAt`, RFC 8621 §4.1.1) at or after
-- `baselined_at`, less a 60 s clock-skew margin (the provider stamps the
-- message, this database stamps the baseline, and the two clocks are not the
-- same clock). Everything older is never copied, however many pages of backlog
-- the account cursor still has to drain.
--
-- It replaced an opaque JMAP Email STATE recorded per member: a state can be
-- compared with nothing but itself, so it only ever excluded the joiner from
-- the one cycle that recorded it, and an account with a backlog longer than
-- that cycle's page cap handed the joiner the rest of the pre-opt-in mail from
-- the next cycle on. A one-cycle exclusion is also harmful under the timestamp
-- rule: it would cost the joiner exactly the mail arriving during that cycle.
--
-- The row is removed when the member stops opting in, so opting back in
-- baselines them again — now — rather than back-filling the gap: the opt-in is
-- forward-looking, in exactly the same sense as the account baseline above.
create table shared_mailbox_member_state (
  user_id uuid not null references users(id) on delete cascade,
  shared_account_id text not null,
  baselined_at timestamptz not null default now(),
  primary key (user_id, shared_account_id)
);

-- The ledger row carries a STATUS, and it is written BEFORE the Email/copy,
-- not after it. Written only afterwards, there was a window in which the
-- provider had already made the copy and nothing recorded it: a crash — or a
-- transient database error, which the cycle counted as a failed copy — replayed
-- the very same copy on the next cycle, and the member got the message twice.
--
-- The row is claimed as `pending`, the copy is issued, and only then is it
-- moved to `copied`. That turns the ambiguous case into a row that stays
-- `pending`, which later cycles skip and count as unresolved rather than
-- re-copy: at-most-once, by design, because a duplicated message is the
-- failure a member notices and a missing one has an obvious recovery — the
-- manual "copy to my inbox" button.
--
-- `failed` is the third state: a copy the provider refused or that threw. Those
-- ARE retried, up to `attempts` tries, so a transient provider failure does not
-- cost a member their copy while the cursor moves past it. `last_error` keeps
-- the last reason for the operator.
--
-- A `failed` row with `attempts = 0` and `last_error = 'member unavailable'` is
-- the same state reached without an attempt: a copy the account OWES a member
-- the cycle could not deliver to at all — deactivated, without a credential, or
-- whose session could not be resolved that cycle. The cursor is per ACCOUNT and
-- advances past the page whatever happens to any one member, so without this
-- row that advance was the loss: nothing else remembers a page the cursor has
-- passed. Written with `on conflict do nothing`, so it can never reopen a
-- `copied` row, answer a `pending` one, or reset the attempts of a `failed` one.
--
-- `message_id` is the SOURCE message's RFC 5322 Message-ID, recorded with the
-- claim, and it exists for exactly one question: a retry has to know whether
-- the copy it is about to make was already made. An Email/copy whose response
-- was lost after the provider committed it looks identical to one that never
-- happened — it is recorded `failed` — and retrying it delivered the message
-- twice. Before re-copying, the cycle asks the member's own account for that
-- Message-ID in their inbox and confirms the row instead if it is there.
--
-- This is NOT the provider-derived dedup rejected above: it is a check on the
-- retry path only, over a copy this deployment claimed itself, and its two
-- weaknesses are bounded accordingly. A member who deleted the copy is asked
-- to receive it again, which is the same answer they get from the manual
-- button; a source with no Message-ID (nullable for that reason) is retried
-- exactly as it was before. The ledger row, not this column, remains the
-- record of what was delivered.
--
-- `received_at` is the SOURCE message's `receivedAt`, recorded with the claim
-- for the same reason: the retry pass works from these rows, not from a page,
-- and it applies the member baseline rule above exactly as the page does. A
-- failed row that predates the member's `baselined_at` spends an attempt
-- instead of being delivered. Nullable only for rows written by hand.
create table shared_mailbox_copies (
  user_id uuid not null references users(id) on delete cascade,
  shared_account_id text not null,
  email_id text not null,
  status text not null default 'pending' check (status in ('pending', 'copied', 'failed')),
  attempts int not null default 0,
  last_error text,
  message_id text,
  received_at timestamptz,
  copied_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, shared_account_id, email_id)
);

-- Every delivery cycle opens by asking this table for the account's failed
-- copies, oldest first — and the primary key leads with `user_id`, so that
-- query has no index to use. The table is never purged and holds a row per
-- (member, message) ever delivered, so the scan grows without limit while the
-- rows it looks for stay a small minority: an account with a million delivered
-- copies and no failures still paid a full scan on every cycle.
--
-- PARTIAL on purpose. Only `failed` rows are retry candidates, so the index
-- carries only those: it stays small, and the `copied` rows that dominate the
-- table cost nothing to keep out of it. The columns are the query's own —
-- `shared_account_id` to find the account, `updated_at` for its `order by`.
create index shared_mailbox_copies_retry_idx
  on shared_mailbox_copies (shared_account_id, updated_at)
  where status = 'failed';
