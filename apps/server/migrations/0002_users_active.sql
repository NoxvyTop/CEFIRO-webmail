alter table users add column active boolean not null default true;
create index users_active_idx on users (active);
