-- GH #314: addresses the user has WRITTEN TO — the store behind Tier A of the
-- sender-trust indicator ("known sender": the message passed DMARC and its
-- From address is one the user has previously sent mail to).
--
-- Fed from three places, all writing through infra/repos/sent-recipients.ts:
-- synchronously from POST /api/mail/send once the submission is confirmed
-- (never before — a failed send is not a correspondent), from the mail-arrival
-- harvest for messages sitting in the Sent mailbox (mail sent from other
-- clients that never passes through this server's /send), and from a one-time
-- bounded backfill of the newest Sent messages the first time the thread route
-- resolves trust for a user (modules/mail/sent-recipients-backfill.ts, marker in
-- user_preferences.preferences.sentRecipientsBackfilledAt).
--
-- Kept deliberately SEPARATE from `contacts` (0006_contacts.sql), even though
-- both are per-user tables of email addresses. `contacts` is a RECEIPT signal:
-- contacts-harvest.ts adds the sender of every non-junk message that arrives,
-- so a phisher earns a contact row simply by sending mail. A trust indicator
-- built on "is in contacts" would therefore mark the second phishing message
-- from the same address as coming from a known sender — the exact inversion
-- this feature must never produce. This table records the OUTBOUND direction
-- only, which a sender cannot trigger. Folding it into `contacts` as another
-- `source` value was considered and rejected for the same reason: one shared
-- row would let a harvested entry be promoted, or a manual add be read as a
-- correspondence, without either being a fact about who the user wrote to.
--
-- `email` is stored lowercased (the repo normalizes on every write, mirroring
-- infra/repos/contacts.ts and users.ts), so the composite primary key gives
-- case-insensitive uniqueness with a plain btree and no citext. The same key
-- serves the read side: the thread route asks `email = any($1)` for the
-- distinct From addresses of one thread, one query per request.
--
-- `first_sent_at` is informational (when the address first became "known");
-- the upsert never updates it, so a row keeps the date of the first send.
-- There is no tombstone table and no user-facing delete: unlike a contact, a
-- correspondence is a fact, not a preference, and it is only ever shown when
-- DMARC has ALSO passed for that exact address.
create table sent_recipients (
  user_id uuid not null references users(id) on delete cascade,
  email text not null,
  first_sent_at timestamptz not null default now(),
  primary key (user_id, email)
);
