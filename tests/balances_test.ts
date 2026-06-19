import { assertEquals } from "@std/assert";
import { netPositions } from "../supabase/functions/_shared/balances.ts";

Deno.test("one split: non-payers owe the payer", () => {
  const events = [{ id: "e1", payerMemberId: "a", voided: false }];
  const shares = [
    { eventId: "e1", memberId: "b", amountCents: 1000 },
    { eventId: "e1", memberId: "c", amountCents: 1000 },
  ];
  const pos = netPositions(events, shares, []);
  const byId = Object.fromEntries(pos.map((p) => [p.memberId, p.cents]));
  assertEquals(byId, { a: 2000, b: -1000, c: -1000 });
});

Deno.test("confirmed settlement reduces the debt", () => {
  const events = [{ id: "e1", payerMemberId: "a", voided: false }];
  const shares = [{ eventId: "e1", memberId: "b", amountCents: 1000 }];
  const settlements = [
    { fromMemberId: "b", toMemberId: "a", amountCents: 1000, status: "confirmed" as const },
  ];
  const pos = netPositions(events, shares, settlements);
  const byId = Object.fromEntries(pos.map((p) => [p.memberId, p.cents]));
  assertEquals(byId, { a: 0, b: 0 });
});

Deno.test("proposed settlement does NOT affect balances", () => {
  const events = [{ id: "e1", payerMemberId: "a", voided: false }];
  const shares = [{ eventId: "e1", memberId: "b", amountCents: 1000 }];
  const settlements = [
    { fromMemberId: "b", toMemberId: "a", amountCents: 1000, status: "proposed" as const },
  ];
  const pos = netPositions(events, shares, settlements);
  const byId = Object.fromEntries(pos.map((p) => [p.memberId, p.cents]));
  assertEquals(byId, { a: 1000, b: -1000 });
});

Deno.test("voided event is ignored", () => {
  const events = [{ id: "e1", payerMemberId: "a", voided: true }];
  const shares = [{ eventId: "e1", memberId: "b", amountCents: 1000 }];
  assertEquals(netPositions(events, shares, []), []);
});

Deno.test("net positions always sum to zero", () => {
  const events = [
    { id: "e1", payerMemberId: "a", voided: false },
    { id: "e2", payerMemberId: "b", voided: false },
  ];
  const shares = [
    { eventId: "e1", memberId: "b", amountCents: 700 },
    { eventId: "e1", memberId: "c", amountCents: 300 },
    { eventId: "e2", memberId: "a", amountCents: 500 },
  ];
  const settlements = [
    { fromMemberId: "c", toMemberId: "a", amountCents: 100, status: "confirmed" as const },
  ];
  const sum = netPositions(events, shares, settlements).reduce((a, p) => a + p.cents, 0);
  assertEquals(sum, 0);
});
