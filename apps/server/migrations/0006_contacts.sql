-- Address book entries, scoped per user (GH #124).
--
-- Case-insensitive uniqueness: enforced the same way users.email already is
-- (0001_initial.sql) rather than with a functional unique index or the
-- citext extension (unused elsewhere in this schema) — the column always
-- stores the lowercased address (see infra/repos/contacts.ts, which
-- normalizes on every write, mirroring infra/repos/users.ts), so a plain
-- unique constraint on (user_id, email) is sufficient.
create table contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null default '',
  email text not null,
  -- 'manual': the user typed this address in themselves via POST /contacts.
  -- 'harvested': auto-added from a received message's From header by the
  -- bulk upsert in infra/repos/contacts.ts (harvestSenders), triggered from
  -- GET /api/mail/messages — see modules/mail/contacts-harvest.ts. Kept as a
  -- plain column (not a second table) so provenance is visible on every row.
  source text not null default 'manual' check (source in ('manual', 'harvested')),
  created_at timestamptz not null default now(),
  unique (user_id, email)
);
create index contacts_user_id_idx on contacts (user_id);

-- Tombstones for addresses a user explicitly deleted from their contacts.
-- Consulted by the harvest bulk upsert so a sender the user removed is never
-- silently re-added the next time their mail is fetched (GH #124: "never
-- resurrect a deleted contact"). A row here deliberately outlives the contact
-- it refers to — deleting the contact does not delete the tombstone — and is
-- only ever cleared by re-adding the same address by hand (see
-- ContactsRepo.create), which is treated as an explicit reversal of the
-- earlier deletion.
create table contact_suppressions (
  user_id uuid not null references users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, email)
);
