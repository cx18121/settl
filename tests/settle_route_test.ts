import { assert, assertEquals } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import { handle } from "../supabase/functions/api/router.ts";

const db = makeDb();

function req(method: string, path: string, headers: Record<string, string> = {}) {
  return new Request(`http://x${path}`, { method, headers });
}

async function settleToken(memberId: string): Promise<string> {
  const { data } = await db.from("members").select("settle_token").eq("id", memberId).single();
  return data!.settle_token as string;
}

function jsonReq(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function seed(claimCreditorHandle: string | null) {
  const made = await (await handle(jsonReq("POST", "/groups", { title: "t" }), db)).json();
  const tok = { "x-settl-token": made.inviteToken };
  const { memberIds } = await (await handle(
    jsonReq("POST", `/groups/${made.groupId}/members`, { names: ["Charlie", "Jake"] }, tok),
    db,
  )).json();
  const [charlie, jake] = memberIds;
  if (claimCreditorHandle) {
    await handle(
      jsonReq("POST", `/groups/${made.groupId}/claim`, {
        memberId: charlie,
        venmoHandle: claimCreditorHandle,
      }, {
        ...tok,
        "x-settl-device": "dev-C",
      }),
      db,
    );
  }
  await handle(
    jsonReq("POST", `/groups/${made.groupId}/splits`, {
      totalCents: 1400,
      payerMemberId: charlie,
      shares: [{ memberId: jake, amountCents: 1400 }],
    }, tok),
    db,
  );
  return { groupId: made.groupId, charlie, jake };
}

Deno.test("GET /settle renders the owed amount and a correct venmo pay link", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, jake } = await seed("charlie-x");
  const t = await settleToken(jake);
  const res = await handle(req("GET", `/settle/${groupId}/${jake}?t=${t}`), db);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");
  assertEquals(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  assert(html.includes("You owe Charlie $14.00"));

  const m = html.match(/href="([^"]+)"/);
  assert(m, "a pay link should be present");
  const pay = new URL(m![1].replaceAll("&amp;", "&"));
  assertEquals(pay.host, "venmo.com");
  assertEquals(pay.pathname, "/charlie-x");
  assertEquals(pay.searchParams.get("txn"), "pay");
  assertEquals(pay.searchParams.get("amount"), "14.00");
  assert((pay.searchParams.get("note") ?? "").length > 0);
});

Deno.test("GET /settle renders one pay link per creditor when a debtor owes several", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const made = await (await handle(jsonReq("POST", "/groups", { title: "t" }), db)).json();
  const tok = { "x-settl-token": made.inviteToken };
  const { memberIds } = await (await handle(
    jsonReq("POST", `/groups/${made.groupId}/members`, { names: ["Charlie", "Dana", "Jake"] }, tok),
    db,
  )).json();
  const [charlie, dana, jake] = memberIds;
  await handle(
    jsonReq("POST", `/groups/${made.groupId}/claim`, {
      memberId: charlie,
      venmoHandle: "charlie-x",
    }, { ...tok, "x-settl-device": "dev-C" }),
    db,
  );
  await handle(
    jsonReq("POST", `/groups/${made.groupId}/claim`, { memberId: dana, venmoHandle: "dana-y" }, {
      ...tok,
      "x-settl-device": "dev-D",
    }),
    db,
  );
  await handle(
    jsonReq("POST", `/groups/${made.groupId}/splits`, {
      totalCents: 1000,
      payerMemberId: charlie,
      shares: [{ memberId: jake, amountCents: 1000 }],
    }, tok),
    db,
  );
  await handle(
    jsonReq("POST", `/groups/${made.groupId}/splits`, {
      totalCents: 600,
      payerMemberId: dana,
      shares: [{ memberId: jake, amountCents: 600 }],
    }, tok),
    db,
  );

  const t = await settleToken(jake);
  const html = await (await handle(req("GET", `/settle/${made.groupId}/${jake}?t=${t}`), db))
    .text();
  assert(html.includes("You owe Charlie $10.00"));
  assert(html.includes("You owe Dana $6.00"));
  assertEquals(html.match(/href="/g)?.length, 2, "one pay button per creditor");
});

Deno.test("GET /settle with a malformed group/member id returns 404, not 500", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const res = await handle(req("GET", `/settle/not-a-uuid/also-bad?t=whatever`), db);
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
});

Deno.test("GET /settle reflects a voided event — a voided debt shows settled up", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, jake } = await seed("charlie-x");
  const { data: g } = await db.from("groups").select("invite_token").eq("id", groupId).single();
  const { data: ev } = await db.from("events").select("id").eq("group_id", groupId).single();
  const auth = { "x-settl-token": g!.invite_token as string, "x-settl-device": "dev-C" };
  await handle(jsonReq("POST", `/groups/${groupId}/events/${ev!.id}/void`, {}, auth), db);
  const t = await settleToken(jake);
  const html = await (await handle(req("GET", `/settle/${groupId}/${jake}?t=${t}`), db)).text();
  assert(html.includes("settled up"));
  assert(!html.includes("href="));
});

Deno.test("GET /settle with a bad token returns a 404 html page", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, jake } = await seed("charlie-x");
  const res = await handle(req("GET", `/settle/${groupId}/${jake}?t=wrong`), db);
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert((await res.text()).includes("isn&#39;t valid"));
});

Deno.test("GET /settle for a settled-up member shows no pay button", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, charlie } = await seed("charlie-x");
  const t = await settleToken(charlie);
  const res = await handle(req("GET", `/settle/${groupId}/${charlie}?t=${t}`), db);
  assertEquals(res.status, 200);
  const html = await res.text();
  assert(html.includes("settled up"));
  assert(!html.includes("href="));
});

Deno.test("GET /settle when the creditor has no venmo handle shows the fallback", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, jake } = await seed(null);
  const t = await settleToken(jake);
  const res = await handle(req("GET", `/settle/${groupId}/${jake}?t=${t}`), db);
  assertEquals(res.status, 200);
  const html = await res.text();
  assert(html.includes("hasn't added a Venmo handle"));
  assert(!html.includes("href="));
});
