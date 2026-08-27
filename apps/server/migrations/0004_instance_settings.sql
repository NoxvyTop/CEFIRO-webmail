create table if not exists instance_settings (
  id integer primary key default 1 check (id = 1),
  sent_with_footer_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into instance_settings (id) values (1) on conflict (id) do nothing;
