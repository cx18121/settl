import { assert, assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";

const url = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.test({
  name: "core tables exist and are queryable",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = createClient(url, key);
    for (const table of ["groups", "members", "events", "shares", "settlements"]) {
      const { error } = await db.from(table).select("*").limit(1);
      assertEquals(error, null, `table ${table} should be queryable`);
    }
  },
});

Deno.test({
  name: "cross-group payer reference is rejected by the schema",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const db = createClient(url, key);
    const { data: g1 } = await db.from("groups").insert({ title: "g1" }).select().single();
    const { data: g2 } = await db.from("groups").insert({ title: "g2" }).select().single();
    const { data: m1 } = await db
      .from("members")
      .insert({ group_id: g1!.id, display_name: "A" })
      .select()
      .single();
    // an event in g2 whose payer belongs to g1 must violate the composite FK
    const { error } = await db.from("events").insert({
      group_id: g2!.id,
      type: "split",
      total_cents: 100,
      payer_member_id: m1!.id,
    });
    assert(error !== null, "cross-group payer insert should fail");
  },
});
