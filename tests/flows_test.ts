import { assert, assertEquals } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import {
  addMembers,
  createGroup,
  createLoan,
  createOrder,
  createPool,
  getNettedTransfers,
} from "../supabase/functions/_shared/repo.ts";

async function seed(d: ReturnType<typeof makeDb>, names: string[]) {
  const { groupId } = await createGroup(d, { title: "t" });
  const { memberIds } = await addMembers(d, { groupId, names });
  return { groupId, memberIds };
}

Deno.test("createPool: contributors each owe the organizer an equal share of target", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, memberIds } = await seed(d, ["Org", "B", "C"]);
  const [org, b, c] = memberIds;
  const { eventId } = await createPool(d, {
    groupId,
    title: "Cabin",
    targetCents: 9000,
    organizerMemberId: org,
    contributorMemberIds: [b, c],
  });
  assert(eventId);
  const { data: ev } = await d.from("events").select("type, target_cents, payer_member_id").eq("id", eventId).single();
  assertEquals(ev!.type, "pool");
  assertEquals(Number(ev!.target_cents), 9000);
  assertEquals(ev!.payer_member_id, org);

  const transfers = await getNettedTransfers(d, groupId);
  assertEquals(transfers.length, 2);
  for (const t of transfers) {
    assertEquals(t.toMemberId, org);
    assertEquals(t.amountCents, 4500);
  }
});

Deno.test("createLoan: borrower owes lender the full amount", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, memberIds } = await seed(d, ["Lender", "Borrower"]);
  const [lender, borrower] = memberIds;
  const { eventId } = await createLoan(d, {
    groupId,
    lenderMemberId: lender,
    borrowerMemberId: borrower,
    amountCents: 5000,
    title: "spotted you",
  });
  const { data: ev } = await d.from("events").select("type").eq("id", eventId).single();
  assertEquals(ev!.type, "loan");
  const transfers = await getNettedTransfers(d, groupId);
  assertEquals(transfers.length, 1);
  assertEquals(transfers[0].fromMemberId, borrower);
  assertEquals(transfers[0].toMemberId, lender);
  assertEquals(transfers[0].amountCents, 5000);
});

Deno.test("createOrder: each item becomes that member's share to the payer", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, memberIds } = await seed(d, ["Payer", "B", "C"]);
  const [payer, b, c] = memberIds;
  const { eventId } = await createOrder(d, {
    groupId,
    payerMemberId: payer,
    title: "boba run",
    items: [
      { memberId: b, amountCents: 650 },
      { memberId: c, amountCents: 720 },
    ],
  });
  const { data: ev } = await d.from("events").select("type, total_cents").eq("id", eventId).single();
  assertEquals(ev!.type, "order");
  assertEquals(Number(ev!.total_cents), 1370);
  const transfers = await getNettedTransfers(d, groupId);
  const byFrom = Object.fromEntries(transfers.map((t) => [t.fromMemberId, t.amountCents]));
  assertEquals(byFrom[b], 650);
  assertEquals(byFrom[c], 720);
  assertEquals(transfers.every((t) => t.toMemberId === payer), true);
});
