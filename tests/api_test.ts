import { assert, assertEquals } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import { handle } from "../supabase/functions/api/router.ts";

const db = makeDb();

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

Deno.test("POST /groups creates a group and returns a token", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const res = await handle(req("POST", "/groups", { title: "trip" }), db);
  assertEquals(res.status, 201);
  const body = await res.json();
  assert(body.groupId && body.inviteToken);
});

Deno.test("group routes reject a missing/wrong token with 403", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const made = await (await handle(req("POST", "/groups", { title: "t" }), db)).json();
  const noTok = await handle(req("POST", `/groups/${made.groupId}/members`, { names: ["A"] }), db);
  assertEquals(noTok.status, 403);
  const badTok = await handle(
    req("POST", `/groups/${made.groupId}/members`, { names: ["A"] }, { "x-settl-token": "nope" }),
    db,
  );
  assertEquals(badTok.status, 403);
});

Deno.test("members + claim + balances happy path", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const made = await (await handle(req("POST", "/groups", { title: "t" }), db)).json();
  const tok = { "x-settl-token": made.inviteToken };
  const mres = await handle(req("POST", `/groups/${made.groupId}/members`, { names: ["A", "B"] }, tok), db);
  assertEquals(mres.status, 201);
  const { memberIds } = await mres.json();

  const claim = await handle(
    req("POST", `/groups/${made.groupId}/claim`, { memberId: memberIds[0], venmoHandle: "alice" },
      { ...tok, "x-settl-device": "dev-A" }),
    db,
  );
  assertEquals(claim.status, 200);

  const bal = await handle(req("GET", `/groups/${made.groupId}/balances`, undefined, tok), db);
  assertEquals(bal.status, 200);
  const body = await bal.json();
  assertEquals(Array.isArray(body.transfers), true);
});

Deno.test("claim hijack returns 409", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const made = await (await handle(req("POST", "/groups", { title: "t" }), db)).json();
  const tok = { "x-settl-token": made.inviteToken };
  const { memberIds } = await (await handle(req("POST", `/groups/${made.groupId}/members`, { names: ["A"] }, tok), db)).json();
  await handle(req("POST", `/groups/${made.groupId}/claim`, { memberId: memberIds[0] }, { ...tok, "x-settl-device": "dev-1" }), db);
  const hijack = await handle(req("POST", `/groups/${made.groupId}/claim`, { memberId: memberIds[0] }, { ...tok, "x-settl-device": "dev-2" }), db);
  assertEquals(hijack.status, 409);
});
