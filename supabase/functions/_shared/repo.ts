import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSharesSumTo } from "./splitMath.ts";

export interface CreateSplitInput {
  groupId: string;
  title: string | null;
  totalCents: number;
  payerMemberId: string;
  shares: { memberId: string; amountCents: number }[];
}

export async function createSplit(
  db: SupabaseClient,
  input: CreateSplitInput,
): Promise<{ eventId: string }> {
  // fast client-side check (unit-tested); the RPC re-validates as the authoritative backstop
  assertSharesSumTo(
    input.totalCents,
    input.shares.map((s) => ({ memberId: s.memberId, amountCents: s.amountCents })),
  );

  const { data, error } = await db.rpc("create_split", {
    p_group_id: input.groupId,
    p_title: input.title,
    p_total_cents: input.totalCents,
    p_payer_member_id: input.payerMemberId,
    p_shares: input.shares.map((s) => ({ member_id: s.memberId, amount_cents: s.amountCents })),
  });
  if (error) throw new Error(`createSplit: ${error.message}`);
  return { eventId: data as string };
}
