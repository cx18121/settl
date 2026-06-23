create function claim_member(
  p_group_id uuid,
  p_member_id uuid,
  p_device_id text,
  p_venmo text
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_rows int;
begin
  update public.members
     set device_id = p_device_id,
         claimed = true,
         venmo_handle = coalesce(p_venmo, venmo_handle)
   where id = p_member_id
     and group_id = p_group_id
     and (device_id is null or device_id = p_device_id);
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
