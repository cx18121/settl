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
  idempotencyKey: string;
  deviceId: string;
}

export async function recordSettlement(
  db: SupabaseClient,
  input: RecordSettlementInput,
): Promise<{ settlementId: string }> {
  if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
    throw new Error("idempotencyKey is required");
  }

  const { data: actor, error: aErr } = await db
    .from("members")
    .select("id")
    .eq("group_id", input.groupId)
    .eq("device_id", input.deviceId)
    .eq("claimed", true)
    .in("id", [input.fromMemberId, input.toMemberId])
    .limit(1)
    .maybeSingle();
  if (aErr) throw new Error(`recordSettlement auth: ${aErr.message}`);
  if (!actor) throw new Error("unauthorized: settlement must be recorded by the debtor or creditor");

  const { data: existing, error: iErr } = await db
    .from("settlements")
    .select("id, from_member_id, to_member_id, amount_cents, method")
    .eq("group_id", input.groupId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (iErr) throw new Error(`recordSettlement idempotency check: ${iErr.message}`);
  if (existing) {
    if (
      existing.from_member_id === input.fromMemberId &&
      existing.to_member_id === input.toMemberId &&
      Number(existing.amount_cents) === input.amountCents &&
      existing.method === input.method
    ) {
      return { settlementId: existing.id as string };
    }
    throw new Error("idempotency key reused with different payment details");
  }

  if (input.amountCents <= 0) throw new Error("settlement amount must be positive");

  const outstanding = (await getNettedTransfers(db, input.groupId)).find(
    (t) => t.fromMemberId === input.fromMemberId && t.toMemberId === input.toMemberId,
  );
  if (!outstanding) {
    throw new Error("no outstanding debt from this member to that member");
  }
  if (input.amountCents > outstanding.amountCents) {
    throw new Error(`amount ${input.amountCents} exceeds outstanding ${outstanding.amountCents}`);
  }

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

  const status = input.method === "venmo" ? "proposed" : "confirmed";
  const { data, error } = await db.rpc("record_settlement", {
    p_group_id: input.groupId,
    p_from: input.fromMemberId,
    p_to: input.toMemberId,
    p_amount: input.amountCents,
    p_method: input.method,
    p_status: status,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw new Error(`recordSettlement: ${error.message}`);
  return { settlementId: data as string };
}

export interface ConfirmSettlementInput {
  groupId: string;
  settlementId: string;
  deviceId: string;
}

export async function confirmSettlement(
  db: SupabaseClient,
  input: ConfirmSettlementInput,
): Promise<void> {
  const { data: s, error: e1 } = await db
    .from("settlements")
    .select("id, to_member_id")
    .eq("id", input.settlementId)
    .eq("group_id", input.groupId)
    .maybeSingle();
  if (e1) throw new Error(`confirmSettlement: ${e1.message}`);
  if (!s) throw new Error("settlement not found");

  const { data: creditor, error: e2 } = await db
    .from("members")
    .select("device_id")
    .eq("id", s.to_member_id)
    .eq("group_id", input.groupId)
    .single();
  if (e2) throw new Error(`confirmSettlement: ${e2.message}`);
  if (!creditor.device_id || creditor.device_id !== input.deviceId) {
    throw new Error("only the creditor's device may confirm this settlement");
  }

  const { data, error } = await db
    .from("settlements")
    .update({ status: "confirmed" })
    .eq("id", input.settlementId)
    .eq("group_id", input.groupId)
    .eq("status", "proposed")
    .select("id");
  if (error) throw new Error(`confirmSettlement: ${error.message}`);
  if (!data || data.length === 0) throw new Error("no proposed settlement found to confirm");
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

export interface CreateLoanInput {
  groupId: string;
  lenderMemberId: string;
  borrowerMemberId: string;
  amountCents: number;
  title?: string | null;
}

export async function createLoan(
  db: SupabaseClient,
  input: CreateLoanInput,
): Promise<{ eventId: string }> {
  const { data, error } = await db.rpc("create_event", {
    p_group_id: input.groupId,
    p_type: "loan",
    p_title: input.title ?? null,
    p_total_cents: input.amountCents,
    p_payer_member_id: input.lenderMemberId,
    p_target_cents: null,
    p_shares: [{ member_id: input.borrowerMemberId, amount_cents: input.amountCents }],
  });
  if (error) throw new Error(`createLoan: ${error.message}`);
  return { eventId: data as string };
}

export interface OrderItem {
  memberId: string;
  amountCents: number;
}

export interface CreateOrderInput {
  groupId: string;
  payerMemberId: string;
  title: string | null;
  items: OrderItem[];
}

export async function createOrder(
  db: SupabaseClient,
  input: CreateOrderInput,
): Promise<{ eventId: string }> {
  if (input.items.length === 0) throw new Error("createOrder needs at least one item");
  const total = input.items.reduce((a, i) => a + i.amountCents, 0);
  const { data, error } = await db.rpc("create_event", {
    p_group_id: input.groupId,
    p_type: "order",
    p_title: input.title,
    p_total_cents: total,
    p_payer_member_id: input.payerMemberId,
    p_target_cents: null,
    p_shares: input.items.map((i) => ({ member_id: i.memberId, amount_cents: i.amountCents })),
  });
  if (error) throw new Error(`createOrder: ${error.message}`);
  return { eventId: data as string };
}

export async function voidEvent(
  db: SupabaseClient,
  input: { groupId: string; eventId: string; deviceId: string },
): Promise<void> {
  const { data: ev, error: evErr } = await db
    .from("events")
    .select("id, payer_member_id")
    .eq("id", input.eventId)
    .eq("group_id", input.groupId)
    .eq("voided", false)
    .maybeSingle();
  if (evErr) throw new Error(`voidEvent: ${evErr.message}`);
  if (!ev) throw new Error("no active event found to void");

  const { data: shareRows, error: shErr } = await db
    .from("shares")
    .select("member_id")
    .eq("event_id", input.eventId);
  if (shErr) throw new Error(`voidEvent: ${shErr.message}`);
  const partyIds = [ev.payer_member_id, ...(shareRows ?? []).map((r) => r.member_id)];

  const { data: actor, error: aErr } = await db
    .from("members")
    .select("id")
    .eq("group_id", input.groupId)
    .eq("device_id", input.deviceId)
    .eq("claimed", true)
    .in("id", partyIds)
    .limit(1)
    .maybeSingle();
  if (aErr) throw new Error(`voidEvent: ${aErr.message}`);
  if (!actor) throw new Error("unauthorized: only a participant of this event may void it");

  const { data, error } = await db
    .from("events")
    .update({ voided: true, voided_by_member_id: actor.id, voided_at: new Date().toISOString() })
    .eq("id", input.eventId)
    .eq("group_id", input.groupId)
    .eq("voided", false)
    .select("id");
  if (error) throw new Error(`voidEvent: ${error.message}`);
  if (!data || data.length === 0) throw new Error("no active event found to void");
}

export interface SettleViewData {
  memberName: string;
  debts: { creditorName: string; amountCents: number; venmoHandle: string | null }[];
}

export async function getSettleView(
  db: SupabaseClient,
  groupId: string,
  memberId: string,
): Promise<SettleViewData> {
  const { data: me, error: meErr } = await db
    .from("members")
    .select("display_name")
    .eq("group_id", groupId)
    .eq("id", memberId)
    .single();
  if (meErr) throw new Error(`getSettleView: ${meErr.message}`);

  const mine = (await getNettedTransfers(db, groupId)).filter((t) => t.fromMemberId === memberId);
  if (mine.length === 0) return { memberName: me.display_name as string, debts: [] };

  const { data: creditors, error: cErr } = await db
    .from("members")
    .select("id, display_name, venmo_handle")
    .eq("group_id", groupId)
    .in("id", mine.map((t) => t.toMemberId));
  if (cErr) throw new Error(`getSettleView: ${cErr.message}`);
  const byId = new Map((creditors ?? []).map((c) => [c.id, c]));

  const debts = mine.map((t) => {
    const c = byId.get(t.toMemberId);
    if (!c) throw new Error(`getSettleView: creditor ${t.toMemberId} not found in group`);
    return {
      creditorName: c.display_name as string,
      amountCents: t.amountCents,
      venmoHandle: (c.venmo_handle as string | null) ?? null,
    };
  });
  return { memberName: me.display_name as string, debts };
}
