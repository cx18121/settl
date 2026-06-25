import { assert, assertNotEquals } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import { addMembers, createGroup } from "../supabase/functions/_shared/repo.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { authorizeSettleToken } from "../supabase/functions/_shared/auth.ts";
import {
  claimMember,
  createSplit,
  getSettleView,
} from "../supabase/functions/_shared/repo.ts";

const db = makeDb();

Deno.test("each member is minted a unique, non-empty settle_token", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId } = await createGroup(db, { title: "t" });
  const { memberIds } = await addMembers(db, { groupId, names: ["A", "B"] });
  const { data, error } = await db
    .from("members")
    .select("id, settle_token")
    .in("id", memberIds);
  assert(!error, error?.message);
  for (const m of data!) {
    assert(typeof m.settle_token === "string" && m.settle_token.length > 0);
  }
  assertNotEquals(data![0].settle_token, data![1].settle_token);
});

Deno.test("getSettleView returns the member's debts with creditor name + handle", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId } = await createGroup(db, { title: "t" });
  const { memberIds } = await addMembers(db, { groupId, names: ["Charlie", "Jake"] });
  const [charlie, jake] = memberIds;
  await claimMember(db, { groupId, memberId: charlie, deviceId: "dev-C", venmoHandle: "charlie-x" });
  await createSplit(db, {
    groupId,
    title: "din",
    totalCents: 1400,
    payerMemberId: charlie,
    shares: [{ memberId: jake, amountCents: 1400 }],
  });

  const view = await getSettleView(db, groupId, jake);
  assertEquals(view.memberName, "Jake");
  assertEquals(view.debts.length, 1);
  assertEquals(view.debts[0].creditorName, "Charlie");
  assertEquals(view.debts[0].amountCents, 1400);
  assertEquals(view.debts[0].venmoHandle, "charlie-x");

  const creditorView = await getSettleView(db, groupId, charlie);
  assertEquals(creditorView.debts.length, 0);
});

Deno.test("authorizeSettleToken accepts the member's token, rejects a wrong one", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId } = await createGroup(db, { title: "t" });
  const { memberIds } = await addMembers(db, { groupId, names: ["A"] });
  const { data } = await db.from("members").select("settle_token").eq("id", memberIds[0]).single();
  await authorizeSettleToken(db, groupId, memberIds[0], data!.settle_token);
  await assertRejects(() => authorizeSettleToken(db, groupId, memberIds[0], "wrong"));
  await assertRejects(() => authorizeSettleToken(db, groupId, memberIds[0], null));
});

Deno.test("authorizeSettleToken treats malformed ids as an invalid link (never a DB error)", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await assertRejects(
    () => authorizeSettleToken(db, "not-a-uuid", "also-not-a-uuid", "tok"),
    Error,
    "invalid settle link",
  );
});

Deno.test("getSettleView returns one debt per creditor when a debtor owes several", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId } = await createGroup(db, { title: "t" });
  const { memberIds } = await addMembers(db, { groupId, names: ["Charlie", "Dana", "Jake"] });
  const [charlie, dana, jake] = memberIds;
  await claimMember(db, { groupId, memberId: charlie, deviceId: "dev-C", venmoHandle: "charlie-x" });
  await claimMember(db, { groupId, memberId: dana, deviceId: "dev-D", venmoHandle: "dana-y" });
  await createSplit(db, {
    groupId, title: "a", totalCents: 1000, payerMemberId: charlie,
    shares: [{ memberId: jake, amountCents: 1000 }],
  });
  await createSplit(db, {
    groupId, title: "b", totalCents: 600, payerMemberId: dana,
    shares: [{ memberId: jake, amountCents: 600 }],
  });

  const view = await getSettleView(db, groupId, jake);
  assertEquals(view.debts.length, 2);
  assertEquals(view.debts.map((d) => d.creditorName).sort(), ["Charlie", "Dana"]);
});
