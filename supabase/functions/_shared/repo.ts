import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSharesSumTo } from "./splitMath.ts";
import { netPositions, type EventRow, type ShareRow, type SettlementRow } from "./balances.ts";
import { minimalTransfers } from "./netting.ts";
import type { Transfer } from "./types.ts";

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

export async function getNettedTransfers(
  db: SupabaseClient,
  groupId: string,
): Promise<Transfer[]> {
  const { data: events, error: e1 } = await db
    .from("events")
    .select("id, payer_member_id, voided")
    .eq("group_id", groupId);
  if (e1) throw new Error(`getNettedTransfers events: ${e1.message}`);

  const eventIds = (events ?? []).map((e) => e.id);
  const { data: shares, error: e2 } = eventIds.length
    ? await db.from("shares").select("event_id, member_id, amount_cents").in("event_id", eventIds)
    : { data: [], error: null };
  if (e2) throw new Error(`getNettedTransfers shares: ${e2.message}`);

  const { data: settlements, error: e3 } = await db
    .from("settlements")
    .select("from_member_id, to_member_id, amount_cents, status")
    .eq("group_id", groupId);
  if (e3) throw new Error(`getNettedTransfers settlements: ${e3.message}`);

  const eventRows: EventRow[] = (events ?? []).map((e) => ({
    id: e.id,
    payerMemberId: e.payer_member_id,
    voided: e.voided,
  }));
  const shareRows: ShareRow[] = (shares ?? []).map((s) => ({
    eventId: s.event_id,
    memberId: s.member_id,
    amountCents: Number(s.amount_cents),
  }));
  const settlementRows: SettlementRow[] = (settlements ?? []).map((s) => ({
    fromMemberId: s.from_member_id,
    toMemberId: s.to_member_id,
    amountCents: Number(s.amount_cents),
    status: s.status,
  }));

  return minimalTransfers(netPositions(eventRows, shareRows, settlementRows));
}
