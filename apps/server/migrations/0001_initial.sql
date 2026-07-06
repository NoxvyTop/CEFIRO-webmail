create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  role text not null default 'employee' check (role in ('employee', 'admin')),
  locale text not null default 'es',
  created_at timestamptz not null default now()
);

create table mail_credentials (
  user_id uuid primary key references users(id) on delete cascade,
  ciphertext bytea not null,
  iv bytea not null,
  key_version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table signatures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  content_html text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table user_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  preferences jsonb not null default '{}'
);

create table sessions (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_expires_at_idx on sessions (expires_at);

create table audit_log (
  id bigint generated always as identity primary key,
  actor text not null,
  action text not null,
  target text,
  ip text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_created_at_idx on audit_log (created_at);

create table sso_config (
  id integer primary key default 1 check (id = 1),
  issuer text not null,
  client_id text not null,
  client_secret_ciphertext bytea not null,
  client_secret_iv bytea not null,
  key_version integer not null default 1,
  scopes text not null default 'openid profile email',
  updated_at timestamptz not null default now()
);

create table integrations (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  config jsonb not null default '{}',
  secrets_ciphertext bytea,
  secrets_iv bytea,
  key_version integer,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);
