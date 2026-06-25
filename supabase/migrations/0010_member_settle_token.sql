alter table members
  add column settle_token text not null default gen_random_uuid()::text;

create unique index members_settle_token_key on members (settle_token);
