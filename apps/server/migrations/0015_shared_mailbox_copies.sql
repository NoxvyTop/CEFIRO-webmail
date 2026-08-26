-- GH #313: automatic opt-in copy delivery for shared mailboxes — the state the
-- background worker (apps/server/src/modules/mail/shared-copy/) needs to
-- follow a shared mailbox over time and to copy each new message to every
-- opted-in member exactly once.
--
-- Two tables, deliberately separate:
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
-- account, source email) that has been copied. Advancing the cursor is not
-- enough on its own, because a page's copies are not atomic with the cursor
-- write — a crash between the last Email/copy and the cursor advance replays
-- the page on the next cycle, and without this ledger every member would get
-- the page twice. The ledger is checked before every copy and written right
-- after a confirmed one, so a replay costs a query, never a duplicate. It is
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
-- is a few dozen bytes per delivered message.
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
-- A member first seen for an account is written here with the state that cycle
-- started from and receives copies only from the NEXT cycle onwards. The row
-- is removed when the member stops opting in, so opting back in baselines them
-- again rather than back-filling the gap: the opt-in is forward-looking, in
-- exactly the same sense as the account baseline above.
create table shared_mailbox_member_state (
  user_id uuid not null references users(id) on delete cascade,
  shared_account_id text not null,
  baselined_state text not null,
  first_seen_at timestamptz not null default now(),
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
create table shared_mailbox_copies (
  user_id uuid not null references users(id) on delete cascade,
  shared_account_id text not null,
  email_id text not null,
  status text not null default 'pending' check (status in ('pending', 'copied', 'failed')),
  attempts int not null default 0,
  last_error text,
  copied_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, shared_account_id, email_id)
);
