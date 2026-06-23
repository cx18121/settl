import { assert, assertEquals } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import {
  addMembers,
  claimMember,
  confirmSettlement,
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

Deno.test("confirmSettlement requires the creditor's device", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, a, b } = await seedBowesA2000(d);
  await claimMember(d, { groupId, memberId: a, deviceId: "dev-A" });
  const { settlementId } = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 2000, method: "venmo", idempotencyKey: "k1",
  });
  let threw = "";
  try { await confirmSettlement(d, { groupId, settlementId, deviceId: "dev-evil" }); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("creditor's device"), `expected creditor-device error, got: ${threw}`);
  assertEquals((await getNettedTransfers(d, groupId)).length, 1, "still owed after rejected confirm");
  await confirmSettlement(d, { groupId, settlementId, deviceId: "dev-A" });
  assertEquals((await getNettedTransfers(d, groupId)).length, 0);
});

Deno.test("confirmSettlement is scoped to its group (cross-group id is rejected)", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, a, b } = await seedBowesA2000(d);
  await claimMember(d, { groupId, memberId: a, deviceId: "dev-A" });
  const { settlementId } = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 2000, method: "venmo", idempotencyKey: "k1",
  });
  const { groupId: otherGroupId } = await createGroup(d, { title: "other" });
  let threw = "";
  try {
    await confirmSettlement(d, { groupId: otherGroupId, settlementId, deviceId: "dev-A" });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("settlement not found"), `expected not-found, got: ${threw}`);
  assertEquals((await getNettedTransfers(d, groupId)).length, 1, "group-1 debt untouched");
});
