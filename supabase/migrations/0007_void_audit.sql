alter table events
  add column voided_by_member_id uuid,
  add column voided_at timestamptz;

alter table events
  add constraint events_voided_by_fk
  foreign key (voided_by_member_id, group_id) references members (id, group_id);
