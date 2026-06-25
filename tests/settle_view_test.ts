import { assert, assertNotEquals } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import { addMembers, createGroup } from "../supabase/functions/_shared/repo.ts";

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
