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
  await claimMember(d, { groupId, memberId: b, deviceId: "dev-B" });
  const first = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 1000, method: "cash",
    idempotencyKey: "key-1", deviceId: "dev-B",
  });
  const second = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 1000, method: "cash",
    idempotencyKey: "key-1", deviceId: "dev-B",
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
  await claimMember(d, { groupId, memberId: b, deviceId: "dev-B" });
  await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 800, method: "cash", idempotencyKey: "k1", deviceId: "dev-B" });
  await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 700, method: "cash", idempotencyKey: "k2", deviceId: "dev-B" });
  const transfers = await getNettedTransfers(d, groupId);
  assertEquals(transfers[0].amountCents, 500);
});

Deno.test("recordSettlement rejects a blank idempotency key", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, a, b } = await seedBowesA2000(d);
  await claimMember(d, { groupId, memberId: b, deviceId: "dev-B" });
  let threw = "";
  try {
    await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 1000, method: "cash", idempotencyKey: "", deviceId: "dev-B" });
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
  await claimMember(d, { groupId, memberId: b, deviceId: "dev-B" });
  await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 800, method: "cash", idempotencyKey: "dup", deviceId: "dev-B" });
  let threw = "";
  try {
    await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 700, method: "cash", idempotencyKey: "dup", deviceId: "dev-B" });
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
  await claimMember(d, { groupId, memberId: b, deviceId: "dev-B" });
  const { settlementId } = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 2000, method: "venmo", idempotencyKey: "k1", deviceId: "dev-B",
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
  await claimMember(d, { groupId, memberId: b, deviceId: "dev-B" });
  const { settlementId } = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 2000, method: "venmo", idempotencyKey: "k1", deviceId: "dev-B",
  });
  const { groupId: otherGroupId } = await createGroup(d, { title: "other" });
  let threw = "";
  try {
    await confirmSettlement(d, { groupId: otherGroupId, settlementId, deviceId: "dev-A" });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("settlement not found"), `expected not-found, got: ${threw}`);
  assertEquals((await getNettedTransfers(d, groupId)).length, 1, "group-1 debt untouched");
});

Deno.test("non-party device is rejected from recording a settlement", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, a, b } = await seedBowesA2000(d);
  const { memberIds: cIds } = await addMembers(d, { groupId, names: ["C"] });
  const [c] = cIds;
  await claimMember(d, { groupId, memberId: c, deviceId: "dev-C" });
  let threw = "";
  try {
    await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 2000, method: "cash", idempotencyKey: "k1", deviceId: "dev-C" });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("debtor or creditor"), `expected party-gate error, got: ${threw}`);
});

Deno.test("retry after confirmation returns the same settlement id", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, a, b } = await seedBowesA2000(d);
  await claimMember(d, { groupId, memberId: a, deviceId: "dev-A" });
  await claimMember(d, { groupId, memberId: b, deviceId: "dev-B" });
  const { settlementId: id1 } = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 2000, method: "venmo", idempotencyKey: "r1", deviceId: "dev-B",
  });
  await confirmSettlement(d, { groupId, settlementId: id1, deviceId: "dev-A" });
  const { settlementId: id2 } = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 2000, method: "venmo", idempotencyKey: "r1", deviceId: "dev-B",
  });
  assertEquals(id2, id1, "retry returns the original settlement id");
  assertEquals((await getNettedTransfers(d, groupId)).length, 0);
});
