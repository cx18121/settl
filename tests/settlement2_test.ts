import { assert, assertEquals } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import {
  addMembers,
  createGroup,
  createSplit,
  getNettedTransfers,
  recordSettlement,
} from "../supabase/functions/_shared/repo.ts";

async function seedBowesA2000(d: ReturnType<typeof makeDb>) {
  const { groupId } = await createGroup(d, { title: "t" });
  const { memberIds } = await addMembers(d, { groupId, names: ["A", "B"] });
  const [a, b] = memberIds;
  await createSplit(d, {
    groupId, title: "x", totalCents: 2000, payerMemberId: a,
    shares: [{ memberId: b, amountCents: 2000 }],
  });
  return { groupId, a, b };
}

Deno.test("recordSettlement with a repeated idempotency key inserts only once", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, a, b } = await seedBowesA2000(d);
  const first = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 1000, method: "cash",
    idempotencyKey: "key-1",
  });
  const second = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 1000, method: "cash",
    idempotencyKey: "key-1",
  });
  assertEquals(first.settlementId, second.settlementId, "same key returns same settlement");
  const { data: rows } = await d.from("settlements").select("id").eq("group_id", groupId);
  assertEquals(rows!.length, 1, "only one settlement row exists");
  const transfers = await getNettedTransfers(d, groupId);
  assertEquals(transfers[0].amountCents, 1000);
});

Deno.test("recordSettlement still allows a genuine second payment (different key)", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, a, b } = await seedBowesA2000(d);
  await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 800, method: "cash", idempotencyKey: "k1" });
  await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 700, method: "cash", idempotencyKey: "k2" });
  const transfers = await getNettedTransfers(d, groupId);
  assertEquals(transfers[0].amountCents, 500);
});

Deno.test("recordSettlement rejects a blank idempotency key", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, a, b } = await seedBowesA2000(d);
  let threw = "";
  try {
    await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 1000, method: "cash", idempotencyKey: "" });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("idempotencyKey is required"), `expected required-key error, got: ${threw}`);
  assertEquals((await d.from("settlements").select("id").eq("group_id", groupId)).data!.length, 0, "nothing inserted");
});

Deno.test("recordSettlement rejects an idempotency key reused for a different payment", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, a, b } = await seedBowesA2000(d);
  await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 800, method: "cash", idempotencyKey: "dup" });
  let threw = "";
  try {
    await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 700, method: "cash", idempotencyKey: "dup" });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("different payment details"), `expected idempotency conflict, got: ${threw}`);
});
