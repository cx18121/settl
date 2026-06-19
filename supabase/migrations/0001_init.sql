create table groups (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  display_name text not null,
  venmo_handle text,
  device_id text,
  claimed boolean not null default false,
  created_at timestamptz not null default now(),
  -- target for composite FKs that pin a reference to this member's group
  unique (id, group_id)
);

create table events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  type text not null check (type in ('split','pool','loan','order')),
  title text,
  total_cents bigint not null check (total_cents >= 0),
  payer_member_id uuid not null,
  target_cents bigint check (target_cents >= 0),
  voided boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, group_id),
  -- payer must belong to THIS event's group
  foreign key (payer_member_id, group_id) references members(id, group_id)
);

create table shares (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  group_id uuid not null,
  member_id uuid not null,
  amount_cents bigint not null check (amount_cents >= 0),
  paid boolean not null default false,
  -- event and member must both belong to the same group as this share
  foreign key (event_id, group_id) references events(id, group_id) on delete cascade,
  foreign key (member_id, group_id) references members(id, group_id)
);

create table settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  from_member_id uuid not null,
  to_member_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  method text not null check (method in ('venmo','apple_cash','cash','other')),
  status text not null default 'proposed' check (status in ('proposed','confirmed')),
  created_at timestamptz not null default now(),
  -- both parties must belong to THIS settlement's group
  foreign key (from_member_id, group_id) references members(id, group_id),
  foreign key (to_member_id, group_id) references members(id, group_id)
);

create index on members(group_id);
create index on events(group_id);
create index on shares(event_id);
create index on settlements(group_id);

-- Race backstop: at most ONE pending settlement per debtor->creditor pair.
-- The app also checks this (nicer error), but the index makes concurrent
-- double-proposals impossible at the DB level, not just unlikely.
create unique index one_pending_settlement_per_pair
  on settlements (group_id, from_member_id, to_member_id)
  where status = 'proposed';
