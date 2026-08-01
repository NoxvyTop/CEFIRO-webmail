-- GH #221: filter rules and vacation settings are committed here and only then
-- pushed to Stalwart as a Sieve script. When the push fails the rows stay, so
-- the user sees filters they believe are active and that never run. This row
-- records whether what Stalwart enforces still matches what this database
-- holds, so the API can say so and a later attempt can reconcile it.
create table sieve_sync_state (
  user_id uuid primary key references users(id) on delete cascade,
  status text not null default 'pending' check (status in ('synced', 'pending', 'failed')),
  -- Consecutive failed attempts since the last successful push; reset on
  -- 'synced'. Diagnostic only — nothing backs off on it.
  attempts integer not null default 0,
  -- The DomainError code of the last failure ('sieve_sync_failed',
  -- 'sieve_invalid', ...), never a message: this is shown to the user.
  last_error text,
  updated_at timestamptz not null default now()
);
