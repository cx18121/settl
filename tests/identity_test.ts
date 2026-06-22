import { assert } from "@std/assert";
import { createClient } from "@supabase/supabase-js";

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
