# Web Settle Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a no-install, read-only HTML page where a debtor sees their netted balance and a [Pay with Venmo] link, reached via a per-member settle token.

**Architecture:** Extend the existing `api` Supabase edge function with one `GET /settle/:groupId/:memberId?t=<settleToken>` route. A new per-member `settle_token` column is the read-only credential. The route authorizes the token, resolves the member's netted debts via the existing `getNettedTransfers`, builds Venmo links, and returns server-rendered HTML. No second host, no client JS, no ledger writes.

**Tech Stack:** Deno, TypeScript, Supabase (Postgres + Edge Functions), `@supabase/supabase-js` (service-role client), `@std/assert`.

## Global Constraints

- **Zero comments in all code** (including tests) — repo Rule 9. The single exception is one line for a genuine load-bearing gotcha.
- **Service-role only** — `makeDb()` uses `SUPABASE_SERVICE_ROLE_KEY`; the edge function is the sole DB client. No RLS, no `grant execute`, no security-definer needed (matches every existing RPC).
- **Read-only page** — the settle route never writes to the ledger. Recording/confirmation stays in the device-gated extension path.
- **Migration numbering** — next is `0010`.
- **Formatting** — `deno fmt` defaults from `deno.json`: spaces, lineWidth 100.
- **DB-touching tests** set `{ sanitizeResources: false, sanitizeOps: false }` (the shared client is never closed — matches existing suites).
- **Full test command** (local Supabase must be running via `supabase start`):
  ```
  SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno task test
  ```
- **Spec:** `docs/superpowers/specs/2026-06-25-settl-web-settle-page-design.md`.

---

## File Structure

- Create: `supabase/migrations/0010_member_settle_token.sql` — add `members.settle_token`.
- Create: `supabase/functions/_shared/venmo.ts` — pure `buildVenmoPayLink`.
- Create: `supabase/functions/_shared/settlePage.ts` — pure `renderSettlePage` + `renderErrorPage`.
- Modify: `supabase/functions/_shared/auth.ts` — add `authorizeSettleToken`.
- Modify: `supabase/functions/_shared/repo.ts` — add `getSettleView`.
- Modify: `supabase/functions/api/router.ts` — add the `GET /settle/...` branch + `handleSettle`.
- Modify: `README.md` — document the route.
- Create: `tests/venmo_test.ts`, `tests/settlePage_test.ts`, `tests/settle_view_test.ts`, `tests/settle_route_test.ts`.

---

### Task 1: Per-member settle token migration

**Files:**
- Create: `supabase/migrations/0010_member_settle_token.sql`
- Test: `tests/settle_view_test.ts` (this one test ships here; the rest of the file is added in Task 4)

**Interfaces:**
- Consumes: existing `createGroup`, `addMembers` from `repo.ts`.
- Produces: `members.settle_token` (text, not null, random default, unique).

- [ ] **Step 1: Write the failing test**

Create `tests/settle_view_test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/settle_view_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `column members.settle_token does not exist` (select errors).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0010_member_settle_token.sql`:

```sql
alter table members
  add column settle_token text not null default gen_random_uuid()::text;

create unique index members_settle_token_key on members (settle_token);
```

- [ ] **Step 4: Apply the migration to local Postgres**

Run: `supabase migration up`
Expected: applies `0010_member_settle_token`. (If the local DB is in a bad state, `supabase db reset` re-runs all migrations + seed.)

- [ ] **Step 5: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/settle_view_test.ts --allow-env --allow-net --allow-read`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0010_member_settle_token.sql tests/settle_view_test.ts
git commit -m "feat: per-member settle_token column (read-only web-settle credential)"
```

---

### Task 2: buildVenmoPayLink (pure)

**Files:**
- Create: `supabase/functions/_shared/venmo.ts`
- Test: `tests/venmo_test.ts`

**Interfaces:**
- Produces: `buildVenmoPayLink(input: { handle: string; amountCents: number; note: string }): string` — returns an `https://venmo.com/?txn=pay&...` URL.

> Venmo publishes no official web-link spec. This mirrors the documented `venmo://paycharge?txn=pay&recipients=&amount=&note=` deep-link params onto the `https://venmo.com/` universal link, with `audience=private`. **Before shipping, confirm this base URL opens a prefilled payment on a real device** (the deep-link params are verified; the HTTPS base is the community-documented convention). The test below asserts parsed components + escaping, so it stays valid regardless of param ordering.

- [ ] **Step 1: Write the failing test**

Create `tests/venmo_test.ts`:

```typescript
import { assert, assertEquals } from "@std/assert";
import { buildVenmoPayLink } from "../supabase/functions/_shared/venmo.ts";

Deno.test("builds an https venmo.com pay link with the right components", () => {
  const link = buildVenmoPayLink({ handle: "charlie-x", amountCents: 1450, note: "Settling up" });
  const u = new URL(link);
  assertEquals(u.protocol, "https:");
  assertEquals(u.host, "venmo.com");
  assertEquals(u.searchParams.get("txn"), "pay");
  assertEquals(u.searchParams.get("audience"), "private");
  assertEquals(u.searchParams.get("recipients"), "charlie-x");
  assertEquals(u.searchParams.get("amount"), "14.50");
  assertEquals(u.searchParams.get("note"), "Settling up");
});

Deno.test("amount renders whole dollars with two decimals", () => {
  const u = new URL(buildVenmoPayLink({ handle: "a", amountCents: 1400, note: "n" }));
  assertEquals(u.searchParams.get("amount"), "14.00");
});

Deno.test("special characters in note and handle survive a round-trip (correct escaping)", () => {
  const note = "a b&c=d?e#f";
  const u = new URL(buildVenmoPayLink({ handle: "x y&z", amountCents: 100, note }));
  assertEquals(u.searchParams.get("note"), note);
  assertEquals(u.searchParams.get("recipients"), "x y&z");
  assert(!u.search.includes("c=d"));
});
```

The round-trip `searchParams.get` returning the exact input proves the `&`, `=`, `?`, `#` were percent-encoded; the final assert confirms the note's literal `c=d` did not leak as a separate query param.

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/venmo_test.ts`
Expected: FAIL — module `venmo.ts` not found / `buildVenmoPayLink` not defined.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/venmo.ts`:

```typescript
export function buildVenmoPayLink(
  input: { handle: string; amountCents: number; note: string },
): string {
  const params = new URLSearchParams({
    txn: "pay",
    audience: "private",
    recipients: input.handle,
    amount: (input.amountCents / 100).toFixed(2),
    note: input.note,
  });
  return `https://venmo.com/?${params.toString()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/venmo_test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/venmo.ts tests/venmo_test.ts
git commit -m "feat: buildVenmoPayLink — escaped https venmo.com pay URL"
```

---

### Task 3: renderSettlePage + renderErrorPage (pure)

**Files:**
- Create: `supabase/functions/_shared/settlePage.ts`
- Test: `tests/settlePage_test.ts`

**Interfaces:**
- Produces:
  - `interface SettleDebt { creditorName: string; amountCents: number; payLink: string | null }`
  - `interface SettlePageView { memberName: string; debts: SettleDebt[] }`
  - `renderSettlePage(view: SettlePageView): string`
  - `renderErrorPage(message: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/settlePage_test.ts`:

```typescript
import { assert } from "@std/assert";
import { renderErrorPage, renderSettlePage } from "../supabase/functions/_shared/settlePage.ts";

Deno.test("owed amount renders with a pay button", () => {
  const html = renderSettlePage({
    memberName: "Jake",
    debts: [{ creditorName: "Charlie", amountCents: 1400, payLink: "https://venmo.com/?txn=pay&amount=14.00" }],
  });
  assert(html.includes("You owe Charlie $14.00"));
  assert(html.includes('href="https://venmo.com/?txn=pay&amp;amount=14.00"'));
  assert(html.includes("Pay with Venmo"));
});

Deno.test("multiple creditors each render a line and a button", () => {
  const html = renderSettlePage({
    memberName: "Jake",
    debts: [
      { creditorName: "Charlie", amountCents: 1400, payLink: "https://venmo.com/?a=1" },
      { creditorName: "Dana", amountCents: 600, payLink: "https://venmo.com/?a=2" },
    ],
  });
  assert(html.includes("You owe Charlie $14.00"));
  assert(html.includes("You owe Dana $6.00"));
});

Deno.test("a settled-up member sees no pay button", () => {
  const html = renderSettlePage({ memberName: "Jake", debts: [] });
  assert(html.includes("settled up"));
  assert(!html.includes("href="));
});

Deno.test("a creditor without a handle shows a fallback, not a button", () => {
  const html = renderSettlePage({
    memberName: "Jake",
    debts: [{ creditorName: "Charlie", amountCents: 1400, payLink: null }],
  });
  assert(html.includes("hasn't added a Venmo handle"));
  assert(!html.includes("href="));
});

Deno.test("a hostile display name is HTML-escaped", () => {
  const html = renderSettlePage({
    memberName: "Jake",
    debts: [{ creditorName: "<script>alert(1)</script>", amountCents: 100, payLink: null }],
  });
  assert(!html.includes("<script>alert(1)</script>"));
  assert(html.includes("&lt;script&gt;"));
});

Deno.test("error page shows the message", () => {
  const html = renderErrorPage("This settle link isn't valid.");
  assert(html.includes("This settle link isn&#39;t valid."));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/settlePage_test.ts`
Expected: FAIL — module `settlePage.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/settlePage.ts`:

```typescript
export interface SettleDebt {
  creditorName: string;
  amountCents: number;
  payLink: string | null;
}

export interface SettlePageView {
  memberName: string;
  debts: SettleDebt[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

const STYLE =
  "body{font-family:-apple-system,system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1.25rem;color:#1a1a1a}" +
  ".debt{margin:1.5rem 0}" +
  "p{font-size:1.25rem;line-height:1.5}" +
  ".pay{display:inline-block;margin-top:.5rem;padding:.75rem 1.25rem;background:#3d95ce;color:#fff;border-radius:.5rem;text-decoration:none;font-weight:600}" +
  ".no-handle{color:#666;font-size:1rem}";

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function renderSettlePage(view: SettlePageView): string {
  if (view.debts.length === 0) {
    return shell("Settl", `<p>You're all settled up 🎉</p>`);
  }
  const blocks = view.debts.map((d) => {
    const line = `<p>You owe ${esc(d.creditorName)} $${dollars(d.amountCents)}</p>`;
    const action = d.payLink
      ? `<a class="pay" href="${esc(d.payLink)}">Pay with Venmo</a>`
      : `<p class="no-handle">${esc(d.creditorName)} hasn't added a Venmo handle yet</p>`;
    return `<div class="debt">${line}${action}</div>`;
  }).join("");
  return shell("Settl", blocks);
}

export function renderErrorPage(message: string): string {
  return shell("Settl", `<p>${esc(message)}</p>`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/settlePage_test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/settlePage.ts tests/settlePage_test.ts
git commit -m "feat: renderSettlePage + renderErrorPage (escaped, self-contained HTML)"
```

---

### Task 4: authorizeSettleToken + getSettleView (data + auth layer)

**Files:**
- Modify: `supabase/functions/_shared/auth.ts`
- Modify: `supabase/functions/_shared/repo.ts`
- Test: `tests/settle_view_test.ts` (append to the file from Task 1)

**Interfaces:**
- Consumes: `getNettedTransfers` (repo.ts), `createGroup`/`addMembers`/`claimMember`/`createSplit` (test seeding).
- Produces:
  - `authorizeSettleToken(db: SupabaseClient, groupId: string, memberId: string, token: string | null): Promise<void>` — throws `"invalid settle link"` on miss.
  - `interface SettleViewData { memberName: string; debts: { creditorName: string; amountCents: number; venmoHandle: string | null }[] }`
  - `getSettleView(db: SupabaseClient, groupId: string, memberId: string): Promise<SettleViewData>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/settle_view_test.ts`:

```typescript
import { assertEquals, assertRejects } from "@std/assert";
import { authorizeSettleToken } from "../supabase/functions/_shared/auth.ts";
import {
  claimMember,
  createSplit,
  getSettleView,
} from "../supabase/functions/_shared/repo.ts";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/settle_view_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `authorizeSettleToken` / `getSettleView` not exported.

- [ ] **Step 3: Add `authorizeSettleToken` to `auth.ts`**

Append to `supabase/functions/_shared/auth.ts`:

```typescript
export async function authorizeSettleToken(
  db: SupabaseClient,
  groupId: string,
  memberId: string,
  token: string | null,
): Promise<void> {
  if (!token) throw new Error("invalid settle link");
  const { data, error } = await db
    .from("members")
    .select("id")
    .eq("group_id", groupId)
    .eq("id", memberId)
    .eq("settle_token", token)
    .maybeSingle();
  if (error) throw new Error(`authorizeSettleToken: ${error.message}`);
  if (!data) throw new Error("invalid settle link");
}
```

- [ ] **Step 4: Add `getSettleView` to `repo.ts`**

Append to `supabase/functions/_shared/repo.ts`:

```typescript
export interface SettleViewData {
  memberName: string;
  debts: { creditorName: string; amountCents: number; venmoHandle: string | null }[];
}

export async function getSettleView(
  db: SupabaseClient,
  groupId: string,
  memberId: string,
): Promise<SettleViewData> {
  const { data: me, error: meErr } = await db
    .from("members")
    .select("display_name")
    .eq("group_id", groupId)
    .eq("id", memberId)
    .single();
  if (meErr) throw new Error(`getSettleView: ${meErr.message}`);

  const mine = (await getNettedTransfers(db, groupId)).filter((t) => t.fromMemberId === memberId);
  if (mine.length === 0) return { memberName: me.display_name as string, debts: [] };

  const { data: creditors, error: cErr } = await db
    .from("members")
    .select("id, display_name, venmo_handle")
    .in("id", mine.map((t) => t.toMemberId));
  if (cErr) throw new Error(`getSettleView: ${cErr.message}`);
  const byId = new Map((creditors ?? []).map((c) => [c.id, c]));

  const debts = mine.map((t) => {
    const c = byId.get(t.toMemberId);
    return {
      creditorName: (c?.display_name as string) ?? "someone",
      amountCents: t.amountCents,
      venmoHandle: (c?.venmo_handle as string | null) ?? null,
    };
  });
  return { memberName: me.display_name as string, debts };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/settle_view_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (3 tests in the file).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/auth.ts supabase/functions/_shared/repo.ts tests/settle_view_test.ts
git commit -m "feat: authorizeSettleToken + getSettleView (read-only settle data layer)"
```

---

### Task 5: GET /settle route (HTTP + HTML layer)

**Files:**
- Modify: `supabase/functions/api/router.ts`
- Test: `tests/settle_route_test.ts`

**Interfaces:**
- Consumes: `authorizeSettleToken` (auth.ts), `getSettleView` (repo.ts), `buildVenmoPayLink` (venmo.ts), `renderSettlePage` + `renderErrorPage` (settlePage.ts).
- Produces: `GET /settle/:groupId/:memberId?t=<token>` → `200 text/html` settle page; `404 text/html` on bad link; `500 text/html` otherwise.

- [ ] **Step 1: Write the failing tests**

Create `tests/settle_route_test.ts`:

```typescript
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

async function jsonReq(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
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
      jsonReq("POST", `/groups/${made.groupId}/claim`, { memberId: charlie, venmoHandle: claimCreditorHandle }, {
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

Deno.test("GET /settle renders the owed amount and a venmo link", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, jake } = await seed("charlie-x");
  const t = await settleToken(jake);
  const res = await handle(req("GET", `/settle/${groupId}/${jake}?t=${t}`), db);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await res.text();
  assert(html.includes("You owe Charlie $14.00"));
  assert(html.includes("venmo.com"));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/settle_route_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `/settle/...` falls through to the JSON 404 (`content-type: application/json`), so the content-type / body assertions fail.

- [ ] **Step 3: Add the settle route to `router.ts`**

Add these imports to the existing import block in `supabase/functions/api/router.ts`:

```typescript
import { authorizeGroup, authorizeSettleToken } from "../_shared/auth.ts";
import { buildVenmoPayLink } from "../_shared/venmo.ts";
import { renderErrorPage, renderSettlePage } from "../_shared/settlePage.ts";
```

(Replace the existing `import { authorizeGroup } from "../_shared/auth.ts";` line; add `getSettleView` to the existing `../_shared/repo.ts` import list.)

Add `handleSettle` above `handle`:

```typescript
function html(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handleSettle(
  db: SupabaseClient,
  groupId: string,
  memberId: string,
  token: string | null,
): Promise<Response> {
  try {
    await authorizeSettleToken(db, groupId, memberId, token);
    const view = await getSettleView(db, groupId, memberId);
    const debts = view.debts.map((d) => ({
      creditorName: d.creditorName,
      amountCents: d.amountCents,
      payLink: d.venmoHandle
        ? buildVenmoPayLink({ handle: d.venmoHandle, amountCents: d.amountCents, note: "Settling up via Settl" })
        : null,
    }));
    return html(renderSettlePage({ memberName: view.memberName, debts }), 200);
  } catch (e) {
    const message = (e as Error).message;
    if (/invalid settle link/i.test(message)) return html(renderErrorPage("This settle link isn't valid."), 404);
    return html(renderErrorPage("Something went wrong. Please try again."), 500);
  }
}
```

Add the route branch at the top of the `try` block in `handle`, before the `groups` checks:

```typescript
    if (req.method === "GET" && parts[0] === "settle" && parts.length === 3) {
      return await handleSettle(db, parts[1], parts[2], url.searchParams.get("t"));
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/settle_route_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/router.ts tests/settle_route_test.ts
git commit -m "feat: GET /settle/:groupId/:memberId — server-rendered web settle page"
```

---

### Task 6: Document the route + full-suite green

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the route in README**

In `README.md`, under the `Routes:` list, add:

```markdown
- `GET  /settle/:groupId/:memberId?t=<settleToken>` → `200 text/html` — public, no-install settle page (read-only): shows the member's netted balance and a Venmo pay link. Bad link → `404 text/html`. Uses a per-member `settle_token`, not the group token.
```

- [ ] **Step 2: Run the FULL suite to verify everything is green**

Run:
```
SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno task test
```
Expected: PASS — all prior suites (63) plus the new venmo (3) + settlePage (6) + settle_view (3) + settle_route (4) tests.

- [ ] **Step 3: Format check**

Run: `deno fmt --check supabase tests`
Expected: no diffs. (If it reports files, run `deno fmt supabase tests` and re-commit.)

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the GET /settle web settle page route"
```

---

## What this plan delivers

A public, no-install web settle page served by the existing `api` edge function: a per-member `settle_token` credential (read-only, distinct from the group invite token), a pure escaped `buildVenmoPayLink`, a pure self-contained-HTML `renderSettlePage`, a `getSettleView` data resolver over the existing netting, and a `GET /settle/:groupId/:memberId` route that authorizes, resolves, renders, and maps bad links to HTML 404s — fully covered by pure unit tests plus local-Supabase integration tests, with no new write path to the ledger.

## Explicitly out of scope

- Web-initiated settlement recording (deferred; recording stays device-gated).
- Pool progress visualization — Plan 4.
- SwiftUI iMessage extension + the chase UI that generates the link — Plan 4.
- Rate limiting beyond the per-member token.
