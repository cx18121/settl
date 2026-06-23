alter table settlements add column idempotency_key text;

create unique index settlements_idempotency_key
  on settlements (group_id, idempotency_key)
  where idempotency_key is not null;

create function record_settlement(
  p_group_id uuid,
  p_from uuid,
  p_to uuid,
  p_amount bigint,
  p_method text,
  p_status text,
  p_idempotency_key text
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing public.settlements%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext(p_group_id::text));

  if p_idempotency_key is not null then
    select * into v_existing
      from public.settlements
     where group_id = p_group_id and idempotency_key = p_idempotency_key;
    if found then
      if v_existing.from_member_id = p_from
         and v_existing.to_member_id = p_to
         and v_existing.amount_cents = p_amount
         and v_existing.method = p_method
         and v_existing.status = p_status then
        return v_existing.id;
      else
        raise exception 'idempotency key reused with different payment details'
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  insert into public.settlements
    (group_id, from_member_id, to_member_id, amount_cents, method, status, idempotency_key)
  values
    (p_group_id, p_from, p_to, p_amount, p_method, p_status, p_idempotency_key)
  returning id into v_id;

  return v_id;
end;
$$;
