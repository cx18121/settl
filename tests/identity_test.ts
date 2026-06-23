import { assert, assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { addMembers, claimMember, createGroup } from "../supabase/functions/_shared/repo.ts";
import { authorizeGroup } from "../supabase/functions/_shared/auth.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = () => createClient(url, key);

Deno.test("each group gets a non-empty unique invite_token", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = db();
  const { data: g1 } = await d.from("groups").insert({ title: "g1" }).select("invite_token").single();
  const { data: g2 } = await d.from("groups").insert({ title: "g2" }).select("invite_token").single();
  assert(g1!.invite_token && g1!.invite_token.length >= 16, "token should be non-trivial");
  assert(g2!.invite_token, "token present");
  assert(g1!.invite_token !== g2!.invite_token, "tokens differ");
});

Deno.test("createGroup returns a token; addMembers seeds unclaimed members", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = db();
  const { groupId, inviteToken } = await createGroup(d, { title: "trip" });
  assert(groupId && inviteToken);

  const { memberIds } = await addMembers(d, { groupId, names: ["A", "B", "C"] });
  assertEquals(memberIds.length, 3);
  const { data: members } = await d.from("members").select("claimed, device_id").eq("group_id", groupId);
  assertEquals(members!.every((m) => m.claimed === false && m.device_id === null), true);
});

Deno.test("authorizeGroup passes with the right token, throws otherwise", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = db();
  const { groupId, inviteToken } = await createGroup(d, { title: "x" });
  await authorizeGroup(d, groupId, inviteToken);
  let threw = "";
  try { await authorizeGroup(d, groupId, "wrong"); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("unauthorized"), `expected unauthorized, got: ${threw}`);
  let threw2 = "";
  try { await authorizeGroup(d, groupId, null); } catch (e) { threw2 = (e as Error).message; }
  assert(threw2.includes("unauthorized"), `expected unauthorized for null token, got: ${threw2}`);
});

Deno.test("addMembers rejects an empty names list", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = db();
  const { groupId } = await createGroup(d, { title: "t" });
  let threw = "";
  try { await addMembers(d, { groupId, names: [] }); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("at least one name"), `expected empty-names error, got: ${threw}`);
});

async function seedGroup(d: ReturnType<typeof db>, names: string[]) {
  const { groupId } = await createGroup(d, { title: "t" });
  const { memberIds } = await addMembers(d, { groupId, names });
  return { groupId, memberIds };
}

Deno.test("claimMember binds a device first-come and sets venmo", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = db();
  const { groupId, memberIds } = await seedGroup(d, ["A", "B"]);
  await claimMember(d, { groupId, memberId: memberIds[0], deviceId: "dev-1", venmoHandle: "alice" });
  const { data: m } = await d.from("members").select("claimed, device_id, venmo_handle").eq("id", memberIds[0]).single();
  assertEquals(m!.claimed, true);
  assertEquals(m!.device_id, "dev-1");
  assertEquals(m!.venmo_handle, "alice");
});

Deno.test("claimMember rejects a different device claiming a held seat", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = db();
  const { groupId, memberIds } = await seedGroup(d, ["A"]);
  await claimMember(d, { groupId, memberId: memberIds[0], deviceId: "dev-1" });
  let threw = "";
  try {
    await claimMember(d, { groupId, memberId: memberIds[0], deviceId: "dev-2" });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("already claimed"), `expected already-claimed, got: ${threw}`);
});

Deno.test("claimMember is idempotent for the same device (updates venmo)", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = db();
  const { groupId, memberIds } = await seedGroup(d, ["A"]);
  await claimMember(d, { groupId, memberId: memberIds[0], deviceId: "dev-1", venmoHandle: "old" });
  await claimMember(d, { groupId, memberId: memberIds[0], deviceId: "dev-1", venmoHandle: "new" });
  const { data: m } = await d.from("members").select("venmo_handle").eq("id", memberIds[0]).single();
  assertEquals(m!.venmo_handle, "new");
});
