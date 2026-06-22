import { assert, assertEquals } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import {
  addMembers,
  createGroup,
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
  // B and C each owe Org 4500
  assertEquals(transfers.length, 2);
  for (const t of transfers) {
    assertEquals(t.toMemberId, org);
    assertEquals(t.amountCents, 4500);
  }
});
