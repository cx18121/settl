import { assertEquals } from "@std/assert";
import { minimalTransfers } from "../supabase/functions/_shared/netting.ts";
import type { NetPosition, Transfer } from "../supabase/functions/_shared/types.ts";

function applyTransfers(positions: NetPosition[], transfers: Transfer[]): Map<string, number> {
  const net = new Map(positions.map((p) => [p.memberId, p.cents]));
  for (const t of transfers) {
    net.set(t.fromMemberId, (net.get(t.fromMemberId) ?? 0) + t.amountCents);
    net.set(t.toMemberId, (net.get(t.toMemberId) ?? 0) - t.amountCents);
  }
  return net;
}

Deno.test("simple two-party debt nets to one transfer", () => {
  const positions: NetPosition[] = [
    { memberId: "a", cents: -1000 }, // a owes
    { memberId: "b", cents: 1000 }, // b is owed
  ];
  const transfers = minimalTransfers(positions);
  assertEquals(transfers, [{ fromMemberId: "a", toMemberId: "b", amountCents: 1000 }]);
});

Deno.test("everyone ends at zero after applying transfers", () => {
  const positions: NetPosition[] = [
    { memberId: "a", cents: -700 },
    { memberId: "b", cents: -300 },
    { memberId: "c", cents: 1000 },
  ];
  const transfers = minimalTransfers(positions);
  for (const [, v] of applyTransfers(positions, transfers)) assertEquals(v, 0);
});

Deno.test("produces at most n-1 transfers", () => {
  const positions: NetPosition[] = [
    { memberId: "a", cents: -500 },
    { memberId: "b", cents: -500 },
    { memberId: "c", cents: 400 },
    { memberId: "d", cents: 600 },
  ];
  const transfers = minimalTransfers(positions);
  assertEquals(transfers.length <= 3, true);
  for (const [, v] of applyTransfers(positions, transfers)) assertEquals(v, 0);
});

Deno.test("all-settled positions produce no transfers", () => {
  const positions: NetPosition[] = [
    { memberId: "a", cents: 0 },
    { memberId: "b", cents: 0 },
  ];
  assertEquals(minimalTransfers(positions), []);
});
