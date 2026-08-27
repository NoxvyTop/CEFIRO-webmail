-- GH #23: the advanced mode. A power user can take the Sieve script over and
-- write it by hand, for the rules the structured builder does not cover.
--
-- Two authors want the same script, so this row records which of them owns it.
-- They are not merged: RFC 5228 §3.2 requires every `require` to precede every
-- other command, so splicing a regenerated block into a hand-written script
-- means hoisting and merging both `require` lists — parsing arbitrary Sieve,
-- which is a parser this project does not have. One author at a time, and the
-- handover is explicit in both directions.
--
-- The script is NEVER deleted by a mode switch: handing ownership back to the
-- rule builder only flips `mode`, so the row survives deactivated and returning
-- to advanced mode restores exactly what the user wrote. Losing hand-written
-- work to a mode switch is the one outcome this feature must not produce.
create table sieve_raw_script (
  user_id uuid primary key references users(id) on delete cascade,
  mode text not null default 'rules' check (mode in ('rules', 'raw')),
  -- Stored verbatim, never rewritten: it is the user's own Sieve, and the API
  -- refuses a blank one, so '' only ever means "never saved a script".
  script text not null default '',
  updated_at timestamptz not null default now()
);
