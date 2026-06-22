import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSharesSumTo, equalSplit } from "./splitMath.ts";
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

  const { data, error } = await db.rpc("create_event", {
    p_group_id: input.groupId,
    p_type: "split",
    p_title: input.title,
    p_total_cents: input.totalCents,
    p_payer_member_id: input.payerMemberId,
    p_target_cents: null,
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

export interface RecordSettlementInput {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amountCents: number;
  method: "venmo" | "apple_cash" | "cash" | "other";
}

export async function recordSettlement(
  db: SupabaseClient,
  input: RecordSettlementInput,
): Promise<{ settlementId: string }> {
  if (input.amountCents <= 0) throw new Error("settlement amount must be positive");

  // The payment must match a real outstanding netted debt from->to, amount <= outstanding.
  // (getNettedTransfers reflects only CONFIRMED settlements, so a pending proposed one does
  // not shrink the outstanding here — the duplicate-guard below stops a double submit.)
  const outstanding = (await getNettedTransfers(db, input.groupId)).find(
    (t) => t.fromMemberId === input.fromMemberId && t.toMemberId === input.toMemberId,
  );
  if (!outstanding) {
    throw new Error("no outstanding debt from this member to that member");
  }
  if (input.amountCents > outstanding.amountCents) {
    throw new Error(`amount ${input.amountCents} exceeds outstanding ${outstanding.amountCents}`);
  }

  // Double-submit guard: at most one pending settlement per from->to pair.
  // This gives a friendly error; the `one_pending_settlement_per_pair` unique
  // index is the real backstop that also holds under concurrent submissions.
  const { data: pending, error: pErr } = await db
    .from("settlements")
    .select("id")
    .eq("group_id", input.groupId)
    .eq("from_member_id", input.fromMemberId)
    .eq("to_member_id", input.toMemberId)
    .eq("status", "proposed")
    .limit(1);
  if (pErr) throw new Error(`recordSettlement pending check: ${pErr.message}`);
  if (pending && pending.length > 0) {
    throw new Error("a pending settlement already exists for this pair");
  }

  // Venmo settlements await the recipient's confirmation; manual marks are self-confirmed.
  const status = input.method === "venmo" ? "proposed" : "confirmed";
  const { data, error } = await db
    .from("settlements")
    .insert({
      group_id: input.groupId,
      from_member_id: input.fromMemberId,
      to_member_id: input.toMemberId,
      amount_cents: input.amountCents,
      method: input.method,
      status,
    })
    .select()
    .single();
  if (error) throw new Error(`recordSettlement: ${error.message}`);
  return { settlementId: data!.id as string };
}

export async function confirmSettlement(db: SupabaseClient, settlementId: string): Promise<void> {
  // Only ever flip a currently-proposed row; matching zero rows is an error (bad id / already confirmed).
  const { data, error } = await db
    .from("settlements")
    .update({ status: "confirmed" })
    .eq("id", settlementId)
    .eq("status", "proposed")
    .select("id");
  if (error) throw new Error(`confirmSettlement: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error("no proposed settlement found to confirm");
  }
}

export async function createGroup(
  db: SupabaseClient,
  input: { title: string | null },
): Promise<{ groupId: string; inviteToken: string }> {
  const { data, error } = await db
    .from("groups")
    .insert({ title: input.title })
    .select("id, invite_token")
    .single();
  if (error) throw new Error(`createGroup: ${error.message}`);
  return { groupId: data!.id as string, inviteToken: data!.invite_token as string };
}

export interface AddMembersInput {
  groupId: string;
  names: string[];
}

export async function addMembers(
  db: SupabaseClient,
  input: AddMembersInput,
): Promise<{ memberIds: string[] }> {
  if (input.names.length === 0) throw new Error("addMembers needs at least one name");
  const { data, error } = await db
    .from("members")
    .insert(input.names.map((n) => ({ group_id: input.groupId, display_name: n })))
    .select("id");
  if (error) throw new Error(`addMembers: ${error.message}`);
  return { memberIds: (data ?? []).map((m) => m.id as string) };
}

export interface ClaimMemberInput {
  groupId: string;
  memberId: string;
  deviceId: string;
  venmoHandle?: string | null;
}

export async function claimMember(db: SupabaseClient, input: ClaimMemberInput): Promise<void> {
  const { data, error } = await db.rpc("claim_member", {
    p_group_id: input.groupId,
    p_member_id: input.memberId,
    p_device_id: input.deviceId,
    p_venmo: input.venmoHandle ?? null,
  });
  if (error) throw new Error(`claimMember: ${error.message}`);
  if (data !== true) throw new Error("member already claimed by another device");
}

export interface CreatePoolInput {
  groupId: string;
  title: string | null;
  targetCents: number;
  organizerMemberId: string;
  contributorMemberIds: string[];
}

export async function createPool(
  db: SupabaseClient,
  input: CreatePoolInput,
): Promise<{ eventId: string }> {
  const shares = equalSplit(input.targetCents, input.contributorMemberIds);
  const { data, error } = await db.rpc("create_event", {
    p_group_id: input.groupId,
    p_type: "pool",
    p_title: input.title,
    p_total_cents: input.targetCents,
    p_payer_member_id: input.organizerMemberId,
    p_target_cents: input.targetCents,
    p_shares: shares.map((s) => ({ member_id: s.memberId, amount_cents: s.amountCents })),
  });
  if (error) throw new Error(`createPool: ${error.message}`);
  return { eventId: data as string };
}
