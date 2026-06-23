alter table groups
  add column invite_token text not null default gen_random_uuid()::text;

create unique index groups_invite_token_key on groups (invite_token);
