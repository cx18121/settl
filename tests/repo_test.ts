import { assertEquals, assert } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import { createSplit } from "../supabase/functions/_shared/repo.ts";

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

    let threw = false;
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
    } catch (_e) {
      threw = true;
    }
    assertEquals(threw, true);
    // the event insert must have rolled back — no orphan event left in the group
    const { data: events } = await db.from("events").select("id").eq("group_id", groupId);
    assertEquals(events!.length, 0);
  },
});
