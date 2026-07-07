create table filter_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  position integer not null,
  name text not null,
  match_type text not null default 'all' check (match_type in ('all', 'any')),
  conditions jsonb not null default '[]',
  actions jsonb not null default '[]',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index filter_rules_user_position_idx on filter_rules (user_id, position);

create table vacation_settings (
  user_id uuid primary key references users(id) on delete cascade,
  enabled boolean not null default false,
  subject text not null default '',
  message text not null default '',
  starts_at date,
  ends_at date,
  interval_days integer not null default 7 check (interval_days between 1 and 60),
  updated_at timestamptz not null default now()
);
