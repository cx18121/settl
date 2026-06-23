create function create_event(
  p_group_id uuid,
  p_type text,
  p_title text,
  p_total_cents bigint,
  p_payer_member_id uuid,
  p_target_cents bigint,
  p_shares jsonb
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_sum bigint;
begin
  select coalesce(sum((s->>'amount_cents')::bigint), 0)
    into v_sum
    from jsonb_array_elements(p_shares) as s;
  if v_sum <> p_total_cents then
    raise exception 'shares must sum to total: got %, expected %', v_sum, p_total_cents
      using errcode = 'check_violation';
  end if;

  insert into public.events (group_id, type, title, total_cents, payer_member_id, target_cents)
  values (p_group_id, p_type, p_title, p_total_cents, p_payer_member_id, p_target_cents)
  returning id into v_event_id;

  insert into public.shares (event_id, group_id, member_id, amount_cents)
  select v_event_id, p_group_id, (s->>'member_id')::uuid, (s->>'amount_cents')::bigint
    from jsonb_array_elements(p_shares) as s;

  return v_event_id;
end;
$$;

drop function create_split(uuid, text, bigint, uuid, jsonb);
