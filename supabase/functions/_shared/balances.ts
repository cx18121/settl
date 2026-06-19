import type { Cents, NetPosition } from "./types.ts";

export interface EventRow {
  id: string;
  payerMemberId: string;
  voided: boolean;
}
export interface ShareRow {
  eventId: string;
  memberId: string;
  amountCents: Cents;
}
export interface SettlementRow {
  fromMemberId: string;
  toMemberId: string;
  amountCents: Cents;
  status: "proposed" | "confirmed";
}

export function netPositions(
  events: EventRow[],
  shares: ShareRow[],
  settlements: SettlementRow[],
): NetPosition[] {
  const payerByEvent = new Map(events.filter((e) => !e.voided).map((e) => [e.id, e.payerMemberId]));
  const net = new Map<string, Cents>();
  const add = (id: string, c: Cents) => net.set(id, (net.get(id) ?? 0) + c);

  for (const s of shares) {
    const payer = payerByEvent.get(s.eventId);
    if (payer === undefined) continue; // event voided or unknown
    if (s.memberId === payer) continue; // payer doesn't owe themselves
    add(s.memberId, -s.amountCents); // debtor owes
    add(payer, s.amountCents); // payer is owed
  }
  for (const st of settlements) {
    if (st.status !== "confirmed") continue;
    add(st.fromMemberId, st.amountCents); // paying reduces your debt
    add(st.toMemberId, -st.amountCents); // receiving reduces what you're owed
  }
  return [...net.entries()].map(([memberId, cents]) => ({ memberId, cents }));
}
