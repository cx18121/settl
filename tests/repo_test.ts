import { assertEquals, assert } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import { createSplit, getNettedTransfers, recordSettlement, confirmSettlement } from "../supabase/functions/_shared/repo.ts";

async function seedGroupWithMembers(db: ReturnType<typeof makeDb>, names: string[]) {
  const { data: g } = await db.from("groups").insert({ title: "test" }).select().single();
  const { data: members } = await db
    .from("members")
    .insert(names.map((n) => ({ group_id: g!.id, display_name: n })))
    .select();
  return { groupId: g!.id as string, members: members! as { id: string; display_name: string }[] };
}

Deno.test({
  name: "createSplit inserts event + shares that sum to total",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, members } = await seedGroupWithMembers(db, ["A", "B", "C"]);
    const [a, b, c] = members;

    const { eventId } = await createSplit(db, {
      groupId,
      title: "Dinner",
      totalCents: 3000,
      payerMemberId: a.id,
      shares: [
        { memberId: b.id, amountCents: 1500 },
        { memberId: c.id, amountCents: 1500 },
      ],
    });

    assert(eventId);
    const { data: ev } = await db.from("events").select("*").eq("id", eventId).single();
    assertEquals(ev!.type, "split");
    assertEquals(Number(ev!.total_cents), 3000);

    const { data: shares } = await db.from("shares").select("*").eq("event_id", eventId);
    assertEquals(shares!.reduce((s, r) => s + Number(r.amount_cents), 0), 3000);
  },
});

Deno.test({
  name: "createSplit rejects shares that do not sum to total",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, members } = await seedGroupWithMembers(db, ["A", "B"]);
    let threw = false;
    try {
      await createSplit(db, {
        groupId,
        title: "Bad",
        totalCents: 1000,
        payerMemberId: members[0].id,
        shares: [{ memberId: members[1].id, amountCents: 900 }],
      });
    } catch (e) {
      threw = (e as Error).message.includes("sum to total");
    }
    assertEquals(threw, true);
  },
});

Deno.test({
  name: "createSplit is atomic: a cross-group member rolls back the whole event",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, members } = await seedGroupWithMembers(db, ["A", "B"]);
    // a member that belongs to a DIFFERENT group
    const { data: other } = await db.from("groups").insert({ title: "other" }).select().single();
    const { data: outsider } = await db
      .from("members")
      .insert({ group_id: other!.id, display_name: "X" })
      .select()
      .single();

    let msg = "";
    try {
      await createSplit(db, {
        groupId,
        title: "Cross",
        totalCents: 2000,
        payerMemberId: members[0].id,
        shares: [
          { memberId: members[1].id, amountCents: 1000 },
          { memberId: outsider!.id, amountCents: 1000 }, // outsider violates the composite FK
        ],
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes("createSplit:"), `expected createSplit error, got: ${msg}`);
    assert(/foreign key|violates|constraint/i.test(msg), `expected FK-violation error, got: ${msg}`);
    // the event insert must have rolled back — no orphan event left in the group
    const { data: events } = await db.from("events").select("id").eq("group_id", groupId);
    assertEquals(events!.length, 0);
  },
});

Deno.test({
  name: "getNettedTransfers returns who-pays-whom for a group",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, members } = await seedGroupWithMembers(db, ["A", "B", "C"]);
    const [a, b, c] = members;
    // A pays 30, split B/C 15 each → B owes A 15, C owes A 15
    await createSplit(db, {
      groupId,
      title: "Dinner",
      totalCents: 3000,
      payerMemberId: a.id,
      shares: [
        { memberId: b.id, amountCents: 1500 },
        { memberId: c.id, amountCents: 1500 },
      ],
    });

    const transfers = await getNettedTransfers(db, groupId);
    // both debtors pay A; 2 transfers, each 1500, all to A
    assertEquals(transfers.length, 2);
    for (const t of transfers) {
      assertEquals(t.toMemberId, a.id);
      assertEquals(t.amountCents, 1500);
    }
  },
});

Deno.test({
  name: "confirmed settlement clears the netted debt",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, members } = await seedGroupWithMembers(db, ["A", "B"]);
    const [a, b] = members;
    await createSplit(db, {
      groupId,
      title: "Loan",
      totalCents: 2000,
      payerMemberId: a.id,
      shares: [{ memberId: b.id, amountCents: 2000 }],
    });
    // before: B owes A 2000
    assertEquals((await getNettedTransfers(db, groupId)).length, 1);

    const { settlementId } = await recordSettlement(db, {
      groupId,
      fromMemberId: b.id,
      toMemberId: a.id,
      amountCents: 2000,
      method: "venmo",
    });
    // venmo settlement starts 'proposed' → still owed until confirmed
    assertEquals((await getNettedTransfers(db, groupId)).length, 1);

    await confirmSettlement(db, settlementId);
    assertEquals((await getNettedTransfers(db, groupId)).length, 0);
  },
});

Deno.test({
  name: "manual (cash) settlement is confirmed immediately",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, members } = await seedGroupWithMembers(db, ["A", "B"]);
    const [a, b] = members;
    await createSplit(db, {
      groupId, title: "x", totalCents: 1000, payerMemberId: a.id,
      shares: [{ memberId: b.id, amountCents: 1000 }],
    });
    await recordSettlement(db, {
      groupId, fromMemberId: b.id, toMemberId: a.id, amountCents: 1000, method: "cash",
    });
    assertEquals((await getNettedTransfers(db, groupId)).length, 0);
  },
});

async function seedBowesA2000(db: ReturnType<typeof makeDb>) {
  const { groupId, members } = await seedGroupWithMembers(db, ["A", "B"]);
  const [a, b] = members;
  await createSplit(db, {
    groupId, title: "x", totalCents: 2000, payerMemberId: a.id,
    shares: [{ memberId: b.id, amountCents: 2000 }],
  });
  return { groupId, a, b }; // B owes A 2000
}

async function expectThrows(fn: () => Promise<unknown>, needle: string) {
  let msg = "";
  try {
    await fn();
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes(needle), `expected error containing "${needle}", got "${msg}"`);
}

Deno.test({
  name: "recordSettlement rejects the wrong direction",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, a, b } = await seedBowesA2000(db);
    // A does not owe B — paying A→B must be refused
    await expectThrows(
      () => recordSettlement(db, { groupId, fromMemberId: a.id, toMemberId: b.id, amountCents: 500, method: "cash" }),
      "no outstanding debt",
    );
  },
});

Deno.test({
  name: "recordSettlement rejects overpayment",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, a, b } = await seedBowesA2000(db);
    await expectThrows(
      () => recordSettlement(db, { groupId, fromMemberId: b.id, toMemberId: a.id, amountCents: 2500, method: "cash" }),
      "exceeds outstanding",
    );
  },
});

Deno.test({
  name: "recordSettlement allows a partial payment and leaves the remainder",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, a, b } = await seedBowesA2000(db);
    await recordSettlement(db, { groupId, fromMemberId: b.id, toMemberId: a.id, amountCents: 500, method: "cash" });
    const transfers = await getNettedTransfers(db, groupId);
    assertEquals(transfers.length, 1);
    assertEquals(transfers[0].fromMemberId, b.id);
    assertEquals(transfers[0].toMemberId, a.id);
    assertEquals(transfers[0].amountCents, 1500);
  },
});

Deno.test({
  name: "recordSettlement rejects a duplicate pending settlement",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, a, b } = await seedBowesA2000(db);
    await recordSettlement(db, { groupId, fromMemberId: b.id, toMemberId: a.id, amountCents: 2000, method: "venmo" });
    await expectThrows(
      () => recordSettlement(db, { groupId, fromMemberId: b.id, toMemberId: a.id, amountCents: 2000, method: "venmo" }),
      "pending settlement already exists",
    );
  },
});

Deno.test({
  name: "confirmSettlement throws when there is no proposed row",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = makeDb();
    const { groupId, a, b } = await seedBowesA2000(db);
    // a cash settlement is already confirmed; confirming it again must fail
    const { settlementId } = await recordSettlement(db, {
      groupId, fromMemberId: b.id, toMemberId: a.id, amountCents: 2000, method: "cash",
    });
    await expectThrows(() => confirmSettlement(db, settlementId), "no proposed settlement");
  },
});
