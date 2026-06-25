import type { SupabaseClient } from "@supabase/supabase-js";

export async function authorizeGroup(
  db: SupabaseClient,
  groupId: string,
  token: string | null,
): Promise<void> {
  if (!token) throw new Error("unauthorized: missing group token");
  const { data, error } = await db
    .from("groups")
    .select("id")
    .eq("id", groupId)
    .eq("invite_token", token)
    .maybeSingle();
  if (error) throw new Error(`authorizeGroup: ${error.message}`);
  if (!data) throw new Error("unauthorized: bad group token");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function authorizeSettleToken(
  db: SupabaseClient,
  groupId: string,
  memberId: string,
  token: string | null,
): Promise<void> {
  if (!token || !UUID_RE.test(groupId) || !UUID_RE.test(memberId)) {
    throw new Error("invalid settle link");
  }
  const { data, error } = await db
    .from("members")
    .select("id")
    .eq("group_id", groupId)
    .eq("id", memberId)
    .eq("settle_token", token)
    .maybeSingle();
  if (error) throw new Error(`authorizeSettleToken: ${error.message}`);
  if (!data) throw new Error("invalid settle link");
}
