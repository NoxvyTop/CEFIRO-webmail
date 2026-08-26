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
create table shared_mailbox_copy_state (
  shared_account_id text primary key,
  email_state text not null,
  updated_at timestamptz not null default now()
);

create table shared_mailbox_copies (
  user_id uuid not null references users(id) on delete cascade,
  shared_account_id text not null,
  email_id text not null,
  copied_at timestamptz not null default now(),
  primary key (user_id, shared_account_id, email_id)
);
