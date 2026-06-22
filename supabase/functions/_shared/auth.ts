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
