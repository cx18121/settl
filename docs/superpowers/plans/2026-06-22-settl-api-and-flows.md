# Settl API & Flows Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Settl's ledger core over an HTTP API with a no-accounts identity layer (group invite-token + device-id), add the remaining creation flows (pools, loans, group-orders), event voiding, and harden settlement recording against concurrency.

**Architecture:** Build on Plan 1's tested service layer (`supabase/functions/_shared/*.ts`) and schema. Add identity (`groups.invite_token`, a `claim_member` RPC, an `authorizeGroup` helper). Generalize the atomic `create_split` Postgres function into `create_event` so pools/loans/orders reuse the same one-transaction event+shares write. Harden settlements with a `record_settlement` RPC (per-group advisory lock + client idempotency key). Expose everything through a single edge function whose request handler — `handle(req, db)` — is a plain function tested directly with constructed `Request` objects (no network/subprocess in tests).

**Tech Stack:** Supabase (Postgres + Edge Functions on Deno), TypeScript on Deno, `deno test`, `@supabase/supabase-js`.

## Global Constraints

- **All money is integer cents** (`number` in TS, `bigint` in DB). Never floats/dollars.
- **Splits/shares sum exactly to the event total** — the `create_event` RPC re-validates and raises on mismatch.
- **Events are immutable** — never UPDATE amounts; "editing" = `voided = true` + recreate. Voided events excluded from balance math.
- **Only `confirmed` settlements affect balances**; `proposed` do not.
- **Net positions of a group always sum to zero.**
- **The schema is a trust boundary**: cross-group references are impossible (composite FKs from Plan 1). Postgres functions set `search_path = ''` and schema-qualify tables (`public.*`).
- **Identity = no accounts.** Authorization rests on a per-group **invite token** (random secret in the share link) + a per-device **device-id**. Being in the group (correct `(group_id, invite_token)`) authorizes read, event creation, settlement recording, and voiding. **Claiming a seat binds a device-id first-come**; a different device claiming an already-claimed seat is rejected; same-device re-claim is idempotent.
- **Confirming a Venmo settlement requires the caller's device to be the one bound to the creditor (`to_member`)** — the only device-gated op.
- **Settlement concurrency**: `record_settlement` runs under a per-group advisory lock + a **required** client `idempotency_key` (unique per group) so retries/concurrent submits can't double-count; a missing/blank key is rejected, and reusing a key for *different* payment details is a 409 conflict (not a silent return). At most one `proposed` settlement per debtor→creditor pair (partial unique index from Plan 1). `amount ≤ outstanding` is a fat-finger UX guard, not a ledger invariant (overpay is economically valid).
- **HTTP**: one edge function `supabase/functions/api/`; its handler is `handle(req: Request, db: SupabaseClient): Promise<Response>`, JSON in/out. Auth headers: `x-settl-token` (group invite token), `x-settl-device` (device id).
- Deno asserts from `jsr:@std/assert@1`. Integration tests run against a local Supabase started via the CLI; service-role key passed as `SUPABASE_SERVICE_ROLE_KEY`. supabase-js's realtime heartbeat trips Deno's resource sanitizer, so integration tests use `Deno.test(name, { sanitizeResources: false, sanitizeOps: false }, fn)` (precedent: `tests/schema_test.ts`, `tests/repo_test.ts`).

## Design notes (read before implementing)

- **Authorization matrix.** `createGroup`: no auth. `addMembers`, `claimMember`, `getNettedTransfers`, `createSplit/Pool/Loan/Order`, `recordSettlement`, `voidEvent`: require valid `(groupId, token)`. `confirmSettlement`: requires valid token **and** caller device == creditor's bound device.
- **Pool semantics.** A pool is a collection toward a target: the organizer is the event `payer`, each contributor owes their equal share of `target_cents` toward the organizer. Mechanically identical to a split the organizer "fronted." A visual progress bar is a Plan 4 (extension) concern and is intentionally **not** built here.
- **Order semantics.** A group-order is a custom split by item; each item is one member's share. It differs from a custom split only by the `type` tag (which later drives different extension UI).
- **`shares.paid` is unused** (balances come from netting, not per-share flags); leave it as-is, do not wire it.
- **Run commands.** Start stack if needed: `supabase status` / `supabase start`. Apply new migrations: `supabase migration up` (if it reports up-to-date but a new file exists, `supabase db reset` reapplies all — wipes data, fine since tests seed their own). Test prefix used throughout:
  `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')"`

## File structure

- `supabase/migrations/0004_invite_token.sql` — add `groups.invite_token`.
- `supabase/migrations/0005_claim_member.sql` — `claim_member` RPC (atomic first-come).
- `supabase/migrations/0006_create_event.sql` — `create_event` RPC; drop `create_split`.
- `supabase/migrations/0007_record_settlement.sql` — `settlements.idempotency_key` + `record_settlement` RPC.
- `supabase/functions/_shared/auth.ts` — `authorizeGroup`.
- `supabase/functions/_shared/repo.ts` — extend: `createGroup`, `addMembers`, `claimMember`, `createPool`, `createLoan`, `createOrder`, `voidEvent`; refactor `createSplit`, `recordSettlement`, `confirmSettlement`.
- `supabase/functions/api/router.ts` — `handle(req, db)` request router.
- `supabase/functions/api/index.ts` — `Deno.serve` entrypoint.
- `tests/identity_test.ts`, `tests/flows_test.ts`, `tests/settlement2_test.ts`, `tests/api_test.ts` — new tests.

---

### Task 1: `invite_token` on groups

**Files:**
- Create: `supabase/migrations/0004_invite_token.sql`
- Test: `tests/identity_test.ts`

**Interfaces:**
- Produces: every `groups` row has a non-null, unique `invite_token` (text).

- [ ] **Step 1: Write the failing test**

Create `tests/identity_test.ts`:
```ts
import { assert, assertEquals } from "@std/assert";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/identity_test.ts --allow-env --allow-net`
Expected: FAIL — column `invite_token` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0004_invite_token.sql`:
```sql
alter table groups
  add column invite_token text not null default gen_random_uuid()::text;

create unique index groups_invite_token_key on groups (invite_token);
```

Apply: `supabase migration up` (or `supabase db reset` if it reports up-to-date).

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/identity_test.ts --allow-env --allow-net`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0004_invite_token.sql tests/identity_test.ts
git commit -m "feat: add groups.invite_token (random unique secret)"
```

---

### Task 2: `authorizeGroup`, `createGroup`, `addMembers`

**Files:**
- Create: `supabase/functions/_shared/auth.ts`
- Modify: `supabase/functions/_shared/repo.ts` (append)
- Test: `tests/identity_test.ts` (append)

**Interfaces:**
- Consumes: `makeDb` (db.ts), `@supabase/supabase-js`.
- Produces:
  - `async function authorizeGroup(db: SupabaseClient, groupId: string, token: string | null): Promise<void>` — throws `"unauthorized: bad group token"` if `token` is missing or doesn't match the group.
  - `async function createGroup(db, input: { title: string | null }): Promise<{ groupId: string; inviteToken: string }>`
  - `interface AddMembersInput { groupId: string; names: string[] }`
  - `async function addMembers(db, input: AddMembersInput): Promise<{ memberIds: string[] }>`

- [ ] **Step 1: Write the failing test (append to `tests/identity_test.ts`)**

```ts
import { addMembers, createGroup } from "../supabase/functions/_shared/repo.ts";
import { authorizeGroup } from "../supabase/functions/_shared/auth.ts";

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
  await authorizeGroup(d, groupId, inviteToken); // no throw
  let threw = "";
  try { await authorizeGroup(d, groupId, "wrong"); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("unauthorized"), `expected unauthorized, got: ${threw}`);
  let threw2 = "";
  try { await authorizeGroup(d, groupId, null); } catch (e) { threw2 = (e as Error).message; }
  assert(threw2.includes("unauthorized"), `expected unauthorized for null token, got: ${threw2}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/identity_test.ts --allow-env --allow-net`
Expected: FAIL — cannot find module `auth.ts` / `createGroup` not exported.

- [ ] **Step 3: Implement**

Create `supabase/functions/_shared/auth.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export async function authorizeGroup(
  db: SupabaseClient,
  groupId: string,
  token: string | null,
): Promise<void> {
  if (!token) throw new Error("unauthorized: missing group token");
  const { data, error } = await db
    .from("groups")
    .select("id")
    .eq("id", groupId)
    .eq("invite_token", token)
    .maybeSingle();
  if (error) throw new Error(`authorizeGroup: ${error.message}`);
  if (!data) throw new Error("unauthorized: bad group token");
}
```

Append to `supabase/functions/_shared/repo.ts`:
```ts
export async function createGroup(
  db: SupabaseClient,
  input: { title: string | null },
): Promise<{ groupId: string; inviteToken: string }> {
  const { data, error } = await db
    .from("groups")
    .insert({ title: input.title })
    .select("id, invite_token")
    .single();
  if (error) throw new Error(`createGroup: ${error.message}`);
  return { groupId: data!.id as string, inviteToken: data!.invite_token as string };
}

export interface AddMembersInput {
  groupId: string;
  names: string[];
}

export async function addMembers(
  db: SupabaseClient,
  input: AddMembersInput,
): Promise<{ memberIds: string[] }> {
  if (input.names.length === 0) throw new Error("addMembers needs at least one name");
  const { data, error } = await db
    .from("members")
    .insert(input.names.map((n) => ({ group_id: input.groupId, display_name: n })))
    .select("id");
  if (error) throw new Error(`addMembers: ${error.message}`);
  return { memberIds: (data ?? []).map((m) => m.id as string) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/identity_test.ts --allow-env --allow-net`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/auth.ts supabase/functions/_shared/repo.ts tests/identity_test.ts
git commit -m "feat: createGroup, addMembers, authorizeGroup (group-token auth)"
```

---

### Task 3: `claimMember` (atomic first-come binding)

**Files:**
- Create: `supabase/migrations/0005_claim_member.sql`
- Modify: `supabase/functions/_shared/repo.ts` (append)
- Test: `tests/identity_test.ts` (append)

**Interfaces:**
- Consumes: `createGroup`, `addMembers`.
- Produces:
  - `interface ClaimMemberInput { groupId: string; memberId: string; deviceId: string; venmoHandle?: string | null }`
  - `async function claimMember(db, input: ClaimMemberInput): Promise<void>` — binds `device_id` first-come via the `claim_member` RPC; throws `"member already claimed by another device"` if the seat is held by a different device.

- [ ] **Step 1: Write the failing test (append to `tests/identity_test.ts`)**

```ts
import { claimMember } from "../supabase/functions/_shared/repo.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/identity_test.ts --allow-env --allow-net`
Expected: FAIL — `claimMember` not exported.

- [ ] **Step 3: Write the migration + repo function**

Create `supabase/migrations/0005_claim_member.sql`:
```sql
-- Atomic first-come claim: succeeds only if the seat is unclaimed or already
-- bound to this same device. Parameterized (no filter-string injection).
create function claim_member(
  p_group_id uuid,
  p_member_id uuid,
  p_device_id text,
  p_venmo text
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_rows int;
begin
  update public.members
     set device_id = p_device_id,
         claimed = true,
         venmo_handle = coalesce(p_venmo, venmo_handle)
   where id = p_member_id
     and group_id = p_group_id
     and (device_id is null or device_id = p_device_id);
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
```

Apply: `supabase migration up` (or `supabase db reset`).

Append to `supabase/functions/_shared/repo.ts`:
```ts
export interface ClaimMemberInput {
  groupId: string;
  memberId: string;
  deviceId: string;
  venmoHandle?: string | null;
}

export async function claimMember(db: SupabaseClient, input: ClaimMemberInput): Promise<void> {
  const { data, error } = await db.rpc("claim_member", {
    p_group_id: input.groupId,
    p_member_id: input.memberId,
    p_device_id: input.deviceId,
    p_venmo: input.venmoHandle ?? null,
  });
  if (error) throw new Error(`claimMember: ${error.message}`);
  if (data !== true) throw new Error("member already claimed by another device");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/identity_test.ts --allow-env --allow-net`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0005_claim_member.sql supabase/functions/_shared/repo.ts tests/identity_test.ts
git commit -m "feat: claimMember atomic first-come device binding"
```

---

### Task 4: generalize `create_split` → `create_event`

**Files:**
- Create: `supabase/migrations/0006_create_event.sql`
- Modify: `supabase/functions/_shared/repo.ts` (`createSplit` body only)
- Test: `tests/repo_test.ts` (existing createSplit tests must stay green; no new test)

**Interfaces:**
- Produces: `create_event(p_group_id uuid, p_type text, p_title text, p_total_cents bigint, p_payer_member_id uuid, p_target_cents bigint, p_shares jsonb) returns uuid` — atomic event+shares insert with server-side sum validation. `createSplit` now delegates to it (type `'split'`, target null); behavior unchanged.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0006_create_event.sql`:
```sql
-- Generalized atomic event+shares writer (supersedes create_split).
-- One transaction: a share failure (e.g. cross-group FK) rolls back the event.
create function create_event(
  p_group_id uuid,
  p_type text,
  p_title text,
  p_total_cents bigint,
  p_payer_member_id uuid,
  p_target_cents bigint,
  p_shares jsonb
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_sum bigint;
begin
  select coalesce(sum((s->>'amount_cents')::bigint), 0)
    into v_sum
    from jsonb_array_elements(p_shares) as s;
  if v_sum <> p_total_cents then
    raise exception 'shares must sum to total: got %, expected %', v_sum, p_total_cents
      using errcode = 'check_violation';
  end if;

  insert into public.events (group_id, type, title, total_cents, payer_member_id, target_cents)
  values (p_group_id, p_type, p_title, p_total_cents, p_payer_member_id, p_target_cents)
  returning id into v_event_id;

  insert into public.shares (event_id, group_id, member_id, amount_cents)
  select v_event_id, p_group_id, (s->>'member_id')::uuid, (s->>'amount_cents')::bigint
    from jsonb_array_elements(p_shares) as s;

  return v_event_id;
end;
$$;

drop function create_split(uuid, text, bigint, uuid, jsonb);
```

Apply: `supabase migration up` (or `supabase db reset`).

- [ ] **Step 2: Run the existing createSplit tests to verify they now FAIL**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/repo_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `createSplit` still calls the now-dropped `create_split` RPC (error mentions `create_split` does not exist).

- [ ] **Step 3: Refactor `createSplit` to call `create_event`**

In `supabase/functions/_shared/repo.ts`, replace the `db.rpc("create_split", {...})` call inside `createSplit` with:
```ts
  const { data, error } = await db.rpc("create_event", {
    p_group_id: input.groupId,
    p_type: "split",
    p_title: input.title,
    p_total_cents: input.totalCents,
    p_payer_member_id: input.payerMemberId,
    p_target_cents: null,
    p_shares: input.shares.map((s) => ({ member_id: s.memberId, amount_cents: s.amountCents })),
  });
  if (error) throw new Error(`createSplit: ${error.message}`);
  return { eventId: data as string };
```
(Leave the `assertSharesSumTo` preflight above it unchanged.)

- [ ] **Step 4: Run the existing createSplit tests to verify they PASS again**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/repo_test.ts --allow-env --allow-net --allow-read`
Expected: PASS — including "createSplit is atomic: a cross-group member rolls back the whole event" (the atomicity guarantee still holds via `create_event`). The atomicity test's error message now references the FK constraint via `createSplit:` — confirm it still matches its `/foreign key|violates|constraint/i` assertion.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0006_create_event.sql supabase/functions/_shared/repo.ts
git commit -m "refactor: generalize create_split into create_event; createSplit delegates"
```

---

### Task 5: `createPool`

**Files:**
- Modify: `supabase/functions/_shared/repo.ts` (append)
- Test: `tests/flows_test.ts`

**Interfaces:**
- Consumes: `equalSplit` (splitMath.ts), `create_event` RPC, `getNettedTransfers`.
- Produces:
  - `interface CreatePoolInput { groupId: string; title: string | null; targetCents: number; organizerMemberId: string; contributorMemberIds: string[] }`
  - `async function createPool(db, input): Promise<{ eventId: string }>` — contributors each owe the organizer an equal share of `targetCents`; event `type = 'pool'`, `target_cents = targetCents`.

- [ ] **Step 1: Write the failing test**

Create `tests/flows_test.ts`:
```ts
import { assert, assertEquals } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import {
  addMembers,
  createGroup,
  createPool,
  getNettedTransfers,
} from "../supabase/functions/_shared/repo.ts";

async function seed(d: ReturnType<typeof makeDb>, names: string[]) {
  const { groupId } = await createGroup(d, { title: "t" });
  const { memberIds } = await addMembers(d, { groupId, names });
  return { groupId, memberIds };
}

Deno.test("createPool: contributors each owe the organizer an equal share of target", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, memberIds } = await seed(d, ["Org", "B", "C"]);
  const [org, b, c] = memberIds;
  const { eventId } = await createPool(d, {
    groupId,
    title: "Cabin",
    targetCents: 9000,
    organizerMemberId: org,
    contributorMemberIds: [b, c],
  });
  assert(eventId);
  const { data: ev } = await d.from("events").select("type, target_cents, payer_member_id").eq("id", eventId).single();
  assertEquals(ev!.type, "pool");
  assertEquals(Number(ev!.target_cents), 9000);
  assertEquals(ev!.payer_member_id, org);

  const transfers = await getNettedTransfers(d, groupId);
  // B and C each owe Org 4500
  assertEquals(transfers.length, 2);
  for (const t of transfers) {
    assertEquals(t.toMemberId, org);
    assertEquals(t.amountCents, 4500);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/flows_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `createPool` not exported.

- [ ] **Step 3: Implement (append to `repo.ts`; ensure `equalSplit` is imported at the top of the file)**

At the top of `repo.ts`, add to the existing imports:
```ts
import { equalSplit } from "./splitMath.ts";
```
(If `assertSharesSumTo` is already imported from `./splitMath.ts`, extend that import to `import { assertSharesSumTo, equalSplit } from "./splitMath.ts";` instead of adding a duplicate line.)

Append:
```ts
export interface CreatePoolInput {
  groupId: string;
  title: string | null;
  targetCents: number;
  organizerMemberId: string;
  contributorMemberIds: string[];
}

export async function createPool(
  db: SupabaseClient,
  input: CreatePoolInput,
): Promise<{ eventId: string }> {
  const shares = equalSplit(input.targetCents, input.contributorMemberIds);
  const { data, error } = await db.rpc("create_event", {
    p_group_id: input.groupId,
    p_type: "pool",
    p_title: input.title,
    p_total_cents: input.targetCents,
    p_payer_member_id: input.organizerMemberId,
    p_target_cents: input.targetCents,
    p_shares: shares.map((s) => ({ member_id: s.memberId, amount_cents: s.amountCents })),
  });
  if (error) throw new Error(`createPool: ${error.message}`);
  return { eventId: data as string };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/flows_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/repo.ts tests/flows_test.ts
git commit -m "feat: createPool (equal-split target toward organizer)"
```

---

### Task 6: `createLoan`

**Files:**
- Modify: `supabase/functions/_shared/repo.ts` (append)
- Test: `tests/flows_test.ts` (append)

**Interfaces:**
- Consumes: `create_event` RPC, `getNettedTransfers`.
- Produces:
  - `interface CreateLoanInput { groupId: string; lenderMemberId: string; borrowerMemberId: string; amountCents: number; title?: string | null }`
  - `async function createLoan(db, input): Promise<{ eventId: string }>` — split-of-one: `type = 'loan'`, payer = lender, single share for the borrower.

- [ ] **Step 1: Write the failing test (append to `tests/flows_test.ts`)**

```ts
import { createLoan } from "../supabase/functions/_shared/repo.ts";

Deno.test("createLoan: borrower owes lender the full amount", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, memberIds } = await seed(d, ["Lender", "Borrower"]);
  const [lender, borrower] = memberIds;
  const { eventId } = await createLoan(d, {
    groupId,
    lenderMemberId: lender,
    borrowerMemberId: borrower,
    amountCents: 5000,
    title: "spotted you",
  });
  const { data: ev } = await d.from("events").select("type").eq("id", eventId).single();
  assertEquals(ev!.type, "loan");
  const transfers = await getNettedTransfers(d, groupId);
  assertEquals(transfers.length, 1);
  assertEquals(transfers[0].fromMemberId, borrower);
  assertEquals(transfers[0].toMemberId, lender);
  assertEquals(transfers[0].amountCents, 5000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/flows_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `createLoan` not exported.

- [ ] **Step 3: Implement (append to `repo.ts`)**

```ts
export interface CreateLoanInput {
  groupId: string;
  lenderMemberId: string;
  borrowerMemberId: string;
  amountCents: number;
  title?: string | null;
}

export async function createLoan(
  db: SupabaseClient,
  input: CreateLoanInput,
): Promise<{ eventId: string }> {
  const { data, error } = await db.rpc("create_event", {
    p_group_id: input.groupId,
    p_type: "loan",
    p_title: input.title ?? null,
    p_total_cents: input.amountCents,
    p_payer_member_id: input.lenderMemberId,
    p_target_cents: null,
    p_shares: [{ member_id: input.borrowerMemberId, amount_cents: input.amountCents }],
  });
  if (error) throw new Error(`createLoan: ${error.message}`);
  return { eventId: data as string };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/flows_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/repo.ts tests/flows_test.ts
git commit -m "feat: createLoan (split-of-one)"
```

---

### Task 7: `createOrder`

**Files:**
- Modify: `supabase/functions/_shared/repo.ts` (append)
- Test: `tests/flows_test.ts` (append)

**Interfaces:**
- Consumes: `create_event` RPC, `getNettedTransfers`.
- Produces:
  - `interface OrderItem { memberId: string; amountCents: number }`
  - `interface CreateOrderInput { groupId: string; payerMemberId: string; title: string | null; items: OrderItem[] }`
  - `async function createOrder(db, input): Promise<{ eventId: string }>` — custom by-item split; `type = 'order'`, total = sum of items.

- [ ] **Step 1: Write the failing test (append to `tests/flows_test.ts`)**

```ts
import { createOrder } from "../supabase/functions/_shared/repo.ts";

Deno.test("createOrder: each item becomes that member's share to the payer", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, memberIds } = await seed(d, ["Payer", "B", "C"]);
  const [payer, b, c] = memberIds;
  const { eventId } = await createOrder(d, {
    groupId,
    payerMemberId: payer,
    title: "boba run",
    items: [
      { memberId: b, amountCents: 650 },
      { memberId: c, amountCents: 720 },
    ],
  });
  const { data: ev } = await d.from("events").select("type, total_cents").eq("id", eventId).single();
  assertEquals(ev!.type, "order");
  assertEquals(Number(ev!.total_cents), 1370);
  const transfers = await getNettedTransfers(d, groupId);
  const byFrom = Object.fromEntries(transfers.map((t) => [t.fromMemberId, t.amountCents]));
  assertEquals(byFrom[b], 650);
  assertEquals(byFrom[c], 720);
  assertEquals(transfers.every((t) => t.toMemberId === payer), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/flows_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `createOrder` not exported.

- [ ] **Step 3: Implement (append to `repo.ts`)**

```ts
export interface OrderItem {
  memberId: string;
  amountCents: number;
}

export interface CreateOrderInput {
  groupId: string;
  payerMemberId: string;
  title: string | null;
  items: OrderItem[];
}

export async function createOrder(
  db: SupabaseClient,
  input: CreateOrderInput,
): Promise<{ eventId: string }> {
  if (input.items.length === 0) throw new Error("createOrder needs at least one item");
  const total = input.items.reduce((a, i) => a + i.amountCents, 0);
  const { data, error } = await db.rpc("create_event", {
    p_group_id: input.groupId,
    p_type: "order",
    p_title: input.title,
    p_total_cents: total,
    p_payer_member_id: input.payerMemberId,
    p_target_cents: null,
    p_shares: input.items.map((i) => ({ member_id: i.memberId, amount_cents: i.amountCents })),
  });
  if (error) throw new Error(`createOrder: ${error.message}`);
  return { eventId: data as string };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/flows_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/repo.ts tests/flows_test.ts
git commit -m "feat: createOrder (custom by-item split)"
```

---

### Task 8: `voidEvent`

**Files:**
- Modify: `supabase/functions/_shared/repo.ts` (append)
- Test: `tests/flows_test.ts` (append)

**Interfaces:**
- Consumes: `createSplit`, `getNettedTransfers`.
- Produces: `async function voidEvent(db, input: { groupId: string; eventId: string }): Promise<void>` — sets `voided = true` on an active event in the group; throws `"no active event found to void"` if none matched (wrong group, missing, or already voided).

- [ ] **Step 1: Write the failing test (append to `tests/flows_test.ts`)**

```ts
import { createSplit, voidEvent } from "../supabase/functions/_shared/repo.ts";

Deno.test("voidEvent reverses the event's balances", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, memberIds } = await seed(d, ["A", "B"]);
  const [a, b] = memberIds;
  const { eventId } = await createSplit(d, {
    groupId, title: "x", totalCents: 1000, payerMemberId: a,
    shares: [{ memberId: b, amountCents: 1000 }],
  });
  assertEquals((await getNettedTransfers(d, groupId)).length, 1);
  await voidEvent(d, { groupId, eventId });
  assertEquals((await getNettedTransfers(d, groupId)).length, 0);
});

Deno.test("voidEvent throws when the event is already voided or missing", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  const { groupId, memberIds } = await seed(d, ["A", "B"]);
  const [a, b] = memberIds;
  const { eventId } = await createSplit(d, {
    groupId, title: "x", totalCents: 500, payerMemberId: a,
    shares: [{ memberId: b, amountCents: 500 }],
  });
  await voidEvent(d, { groupId, eventId });
  let threw = "";
  try { await voidEvent(d, { groupId, eventId }); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("no active event"), `expected no-active-event, got: ${threw}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/flows_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `voidEvent` not exported.

- [ ] **Step 3: Implement (append to `repo.ts`)**

```ts
export async function voidEvent(
  db: SupabaseClient,
  input: { groupId: string; eventId: string },
): Promise<void> {
  const { data, error } = await db
    .from("events")
    .update({ voided: true })
    .eq("id", input.eventId)
    .eq("group_id", input.groupId)
    .eq("voided", false)
    .select("id");
  if (error) throw new Error(`voidEvent: ${error.message}`);
  if (!data || data.length === 0) throw new Error("no active event found to void");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/flows_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/repo.ts tests/flows_test.ts
git commit -m "feat: voidEvent (immutable-edit reversal)"
```

---

### Task 9: settlement concurrency hardening (`record_settlement` RPC + idempotency)

**Files:**
- Create: `supabase/migrations/0007_record_settlement.sql`
- Modify: `supabase/functions/_shared/repo.ts` (`RecordSettlementInput` + `recordSettlement` body)
- Test: `tests/settlement2_test.ts`

**Interfaces:**
- Consumes: `getNettedTransfers`, `createSplit`, `createGroup`, `addMembers`.
- Produces:
  - `RecordSettlementInput` gains a **required** `idempotencyKey: string` (non-blank). Idempotency is mandatory: it's the only thing that makes "a retried submit can't double-count" true, so a missing/blank key is rejected rather than silently inserting.
  - `recordSettlement` keeps its TS validation (outstanding/direction/overpay/dup-pending UX guards) but inserts via the `record_settlement(p_group_id, p_from, p_to, p_amount, p_method, p_status, p_idempotency_key)` RPC, which serializes per-group via `pg_advisory_xact_lock` and returns the existing row's id when the idempotency key was already used.

- [ ] **Step 1: Write the failing test**

Create `tests/settlement2_test.ts`:
```ts
import { assert, assertEquals } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import {
  addMembers,
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
  // and the debt only dropped by 1000 (one payment), not 2000
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
  assertEquals(transfers[0].amountCents, 500); // 2000 - 800 - 700
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
    // same key, different amount → must NOT silently return the old settlement
    await recordSettlement(d, { groupId, fromMemberId: b, toMemberId: a, amountCents: 700, method: "cash", idempotencyKey: "dup" });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("different payment details"), `expected idempotency conflict, got: ${threw}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/settlement2_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `idempotencyKey` not honored / `record_settlement` RPC missing (the dup test sees 2 rows; the required-key and reuse-conflict tests have no guard yet).

- [ ] **Step 3: Write the migration + refactor `recordSettlement`**

Create `supabase/migrations/0007_record_settlement.sql`:
```sql
alter table settlements add column idempotency_key text;

create unique index settlements_idempotency_key
  on settlements (group_id, idempotency_key)
  where idempotency_key is not null;

-- Serialize settlement inserts per-group and dedup by idempotency key.
create function record_settlement(
  p_group_id uuid,
  p_from uuid,
  p_to uuid,
  p_amount bigint,
  p_method text,
  p_status text,
  p_idempotency_key text
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing public.settlements%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext(p_group_id::text));

  if p_idempotency_key is not null then
    select * into v_existing
      from public.settlements
     where group_id = p_group_id and idempotency_key = p_idempotency_key;
    if found then
      -- exact replay → return the same id; otherwise the key was reused for a
      -- different payment, which is a client bug we must surface, not mask.
      if v_existing.from_member_id = p_from
         and v_existing.to_member_id = p_to
         and v_existing.amount_cents = p_amount
         and v_existing.method = p_method
         and v_existing.status = p_status then
        return v_existing.id;
      else
        raise exception 'idempotency key reused with different payment details'
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  insert into public.settlements
    (group_id, from_member_id, to_member_id, amount_cents, method, status, idempotency_key)
  values
    (p_group_id, p_from, p_to, p_amount, p_method, p_status, p_idempotency_key)
  returning id into v_id;

  return v_id;
end;
$$;
```

Apply: `supabase migration up` (or `supabase db reset`).

In `supabase/functions/_shared/repo.ts`, change the `RecordSettlementInput` interface to add the **required** key:
```ts
export interface RecordSettlementInput {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amountCents: number;
  method: "venmo" | "apple_cash" | "cash" | "other";
  idempotencyKey: string;
}
```
Then, inside `recordSettlement`, add a guard at the very top (before the positive-amount check) and keep the rest of the existing validation (positive amount, outstanding lookup, overpay check, pending-dup check), and replace the final `db.from("settlements").insert(...)` block with the RPC call:
```ts
  if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
    throw new Error("idempotencyKey is required");
  }
```
```ts
  const status = input.method === "venmo" ? "proposed" : "confirmed";
  const { data, error } = await db.rpc("record_settlement", {
    p_group_id: input.groupId,
    p_from: input.fromMemberId,
    p_to: input.toMemberId,
    p_amount: input.amountCents,
    p_method: input.method,
    p_status: status,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw new Error(`recordSettlement: ${error.message}`);
  return { settlementId: data as string };
```

**Update every existing `recordSettlement` call to pass a key.** Because the field is now required, the Plan-1 settlement tests in `tests/repo_test.ts` (confirmed-clears-debt, manual-cash, wrong-direction, overpay, partial, duplicate-pending, confirm-no-proposed-row) must each add `idempotencyKey: "k1"`. **Exception — the duplicate-pending test makes two `recordSettlement` calls for the same pair: give the first `idempotencyKey: "k1"` and the second `idempotencyKey: "k2"`**, otherwise the second call would be deduped by idempotency and return the first id instead of hitting the "pending settlement already exists" guard. Likewise, the two `recordSettlement` calls in the Task-10 confirm tests in `tests/settlement2_test.ts` (creditor-device test and cross-group test) each need an `idempotencyKey` (e.g. `"k1"`).

**Concurrency safety model (read this — the TS validation runs *before* the lock by design):** the only outcome that corrupts the ledger is counting the *same* payment twice, and that is closed *inside* the advisory lock by the idempotency-key dedup. Duplicate *pending* proposals are closed by the `settlements_idempotency_key`-sibling partial unique index (a hard DB constraint — the second concurrent insert fails even if the TS check raced). The remaining racy check, `amount ≤ outstanding`, is a **best-effort fat-finger guard, not a ledger invariant**: two genuine concurrent payments (different idempotency keys) can both pass it and produce an overpay, which is **economically valid** (the recipient simply now owes the difference; net positions still sum to zero, and it's group-visible and disputable). We deliberately do **not** reimplement the netting engine in SQL to make this guard airtight — that would duplicate the tested TS engine to defend a guard whose failure mode is acceptable. Do not "fix" this by moving netting into the RPC.

- [ ] **Step 4: Run the new test AND the existing settlement tests to verify all pass**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/settlement2_test.ts tests/repo_test.ts --allow-env --allow-net --allow-read`
Expected: PASS — the 4 new idempotency tests (dedup, different-key, blank-key rejected, reuse-conflict) plus the existing `recordSettlement` validation tests in `repo_test.ts` (wrong-direction, overpay, partial, duplicate-pending), now each carrying an `idempotencyKey`, all green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0007_record_settlement.sql supabase/functions/_shared/repo.ts tests/settlement2_test.ts
git commit -m "feat: record_settlement RPC (per-group advisory lock + idempotency key)"
```

---

### Task 10: `confirmSettlement` requires the creditor's device

**Files:**
- Modify: `supabase/functions/_shared/repo.ts` (`confirmSettlement` signature + body)
- Modify: `tests/repo_test.ts` (update the existing confirm test to claim the creditor + pass a device)
- Test: `tests/settlement2_test.ts` (append)

**Interfaces:**
- Produces:
  - `interface ConfirmSettlementInput { groupId: string; settlementId: string; deviceId: string }`
  - `async function confirmSettlement(db, input: ConfirmSettlementInput): Promise<void>` — flips a `proposed` settlement to `confirmed` **only if** the settlement belongs to `groupId` (tenant scope) **and** `deviceId` matches the creditor (`to_member`)'s bound `device_id`; throws `"settlement not found"` if it isn't in this group, `"only the creditor's device may confirm"` on device mismatch, and `"no proposed settlement found to confirm"` if nothing matched. The `groupId` scope is load-bearing: the HTTP route only authorizes the URL's group token, so without scoping the lookup+update by `group_id` a caller with one group's token could confirm a settlement in another group.

- [ ] **Step 1: Update the existing confirm test in `tests/repo_test.ts` to the new signature, and add the wrong-device test in `tests/settlement2_test.ts`**

In `tests/repo_test.ts`, the existing test "confirmed settlement clears the netted debt" calls `confirmSettlement(db, settlementId)`. Update it so the creditor (`a`) claims a device first and the call passes that device. Replace the `confirmSettlement(db, settlementId)` line and the lines that create the members so `a` is claimed:
```ts
  // creditor A claims a device so they can confirm receipt
  await claimMember(db, { groupId, memberId: a.id, deviceId: "dev-A" });
  // ...after recordSettlement returns { settlementId }:
  await confirmSettlement(db, { groupId, settlementId, deviceId: "dev-A" });
```
Add `claimMember` (and keep `confirmSettlement`) to the existing import from `repo.ts` at the top of `tests/repo_test.ts`. The members in that test are created via the file's `seedGroupWithMembers` helper which returns `{ groupId, members }`; use the returned `groupId` and `a.id` for the claim.

Append to `tests/settlement2_test.ts`:
```ts
import { claimMember, confirmSettlement } from "../supabase/functions/_shared/repo.ts";

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
  // wrong device cannot confirm
  let threw = "";
  try { await confirmSettlement(d, { groupId, settlementId, deviceId: "dev-evil" }); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("creditor's device"), `expected creditor-device error, got: ${threw}`);
  assertEquals((await getNettedTransfers(d, groupId)).length, 1, "still owed after rejected confirm");
  // creditor's device confirms
  await confirmSettlement(d, { groupId, settlementId, deviceId: "dev-A" });
  assertEquals((await getNettedTransfers(d, groupId)).length, 0);
});

Deno.test("confirmSettlement is scoped to its group (cross-group id is rejected)", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const d = makeDb();
  // group 1: B owes A, A claims dev-A, a proposed venmo settlement exists
  const { groupId, a, b } = await seedBowesA2000(d);
  await claimMember(d, { groupId, memberId: a, deviceId: "dev-A" });
  const { settlementId } = await recordSettlement(d, {
    groupId, fromMemberId: b, toMemberId: a, amountCents: 2000, method: "venmo", idempotencyKey: "k1",
  });
  // group 2: a separate group the attacker legitimately belongs to
  const { groupId: otherGroupId } = await createGroup(d, { title: "other" });
  // even WITH the creditor device, the settlement cannot be confirmed via another group's id
  let threw = "";
  try {
    await confirmSettlement(d, { groupId: otherGroupId, settlementId, deviceId: "dev-A" });
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("settlement not found"), `expected not-found, got: ${threw}`);
  assertEquals((await getNettedTransfers(d, groupId)).length, 1, "group-1 debt untouched");
});
```
The cross-group test also needs `createGroup` imported into `tests/settlement2_test.ts` (extend the existing `repo.ts` import).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/settlement2_test.ts tests/repo_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `confirmSettlement` still takes a string, not `{ groupId, settlementId, deviceId }`; the device check and group scoping don't exist.

- [ ] **Step 3: Implement the new `confirmSettlement`**

In `supabase/functions/_shared/repo.ts`, replace the existing `confirmSettlement` with:
```ts
export interface ConfirmSettlementInput {
  groupId: string;
  settlementId: string;
  deviceId: string;
}

export async function confirmSettlement(
  db: SupabaseClient,
  input: ConfirmSettlementInput,
): Promise<void> {
  // Scope the lookup to the group (tenant boundary): a settlement id from
  // another group must not be confirmable with this group's token.
  const { data: s, error: e1 } = await db
    .from("settlements")
    .select("id, to_member_id")
    .eq("id", input.settlementId)
    .eq("group_id", input.groupId)
    .maybeSingle();
  if (e1) throw new Error(`confirmSettlement: ${e1.message}`);
  if (!s) throw new Error("settlement not found");

  const { data: creditor, error: e2 } = await db
    .from("members")
    .select("device_id")
    .eq("id", s.to_member_id)
    .single();
  if (e2) throw new Error(`confirmSettlement: ${e2.message}`);
  if (!creditor.device_id || creditor.device_id !== input.deviceId) {
    throw new Error("only the creditor's device may confirm this settlement");
  }

  const { data, error } = await db
    .from("settlements")
    .update({ status: "confirmed" })
    .eq("id", input.settlementId)
    .eq("group_id", input.groupId)
    .eq("status", "proposed")
    .select("id");
  if (error) throw new Error(`confirmSettlement: ${error.message}`);
  if (!data || data.length === 0) throw new Error("no proposed settlement found to confirm");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/settlement2_test.ts tests/repo_test.ts --allow-env --allow-net --allow-read`
Expected: PASS — updated confirm test + new wrong-device test + new cross-group-scope test green.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/repo.ts tests/repo_test.ts tests/settlement2_test.ts
git commit -m "feat: confirmSettlement requires the creditor's bound device"
```

---

### Task 11: HTTP router foundation (groups, members, claim, balances)

**Files:**
- Create: `supabase/functions/api/router.ts`
- Create: `supabase/functions/api/index.ts`
- Test: `tests/api_test.ts`

**Interfaces:**
- Consumes: all repo functions, `authorizeGroup`.
- Produces:
  - `async function handle(req: Request, db: SupabaseClient): Promise<Response>` — JSON router. Reads `x-settl-token` and `x-settl-device` headers. Routes in this task:
    - `POST /groups` → `{ title? }` → 201 `{ groupId, inviteToken }` (no auth)
    - `POST /groups/:id/members` → `{ names: string[] }` → 201 `{ memberIds }` (token)
    - `POST /groups/:id/claim` → `{ memberId, venmoHandle? }` + device header → 200 `{ ok: true }` (token)
    - `GET /groups/:id/balances` → 200 `{ transfers }` (token)
  - Error mapping: messages containing `unauthorized`/`creditor's device` → 403; `already claimed`/`pending settlement already exists`/`different payment details` → 409; `not found`/`no active event`/`no proposed settlement` → 404; otherwise → 400.

- [ ] **Step 1: Write the failing test**

Create `tests/api_test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/api_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — cannot find module `router.ts`.

- [ ] **Step 3: Implement the router foundation**

Create `supabase/functions/api/router.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeGroup } from "../_shared/auth.ts";
import {
  addMembers,
  claimMember,
  createGroup,
  getNettedTransfers,
} from "../_shared/repo.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function statusForError(message: string): number {
  if (/unauthorized|creditor's device/i.test(message)) return 403;
  if (/already claimed|pending settlement already exists|different payment details/i.test(message)) return 409;
  if (/not found|no active event|no proposed settlement/i.test(message)) return 404;
  return 400;
}

export async function handle(req: Request, db: SupabaseClient): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ["groups", ":id", "members"]
  const token = req.headers.get("x-settl-token");
  const device = req.headers.get("x-settl-device");
  const body = async () => (req.body ? await req.json() : {});

  try {
    // POST /groups
    if (req.method === "POST" && parts.length === 1 && parts[0] === "groups") {
      const b = await body();
      const out = await createGroup(db, { title: b.title ?? null });
      return json(out, 201);
    }

    // /groups/:id/...
    if (parts[0] === "groups" && parts.length >= 3) {
      const groupId = parts[1];
      const sub = parts[2];

      if (req.method === "POST" && sub === "members" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await addMembers(db, { groupId, names: b.names ?? [] });
        return json(out, 201);
      }

      if (req.method === "POST" && sub === "claim" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        if (!device) throw new Error("missing device id");
        const b = await body();
        await claimMember(db, {
          groupId,
          memberId: b.memberId,
          deviceId: device,
          venmoHandle: b.venmoHandle ?? null,
        });
        return json({ ok: true }, 200);
      }

      if (req.method === "GET" && sub === "balances" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const transfers = await getNettedTransfers(db, groupId);
        return json({ transfers }, 200);
      }
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    const message = (e as Error).message;
    return json({ error: message }, statusForError(message));
  }
}
```

Create `supabase/functions/api/index.ts`:
```ts
import { handle } from "./router.ts";
import { makeDb } from "../_shared/db.ts";

Deno.serve((req) => handle(req, makeDb()));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/api_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/router.ts supabase/functions/api/index.ts tests/api_test.ts
git commit -m "feat: HTTP router foundation (groups, members, claim, balances)"
```

---

### Task 12: HTTP creation routes (splits, pools, loans, orders)

**Files:**
- Modify: `supabase/functions/api/router.ts` (add route branches)
- Test: `tests/api_test.ts` (append)

**Interfaces:**
- Produces (all require token; return 201 `{ eventId }`):
  - `POST /groups/:id/splits` → `{ title?, totalCents, payerMemberId, shares: [{memberId, amountCents}] }`
  - `POST /groups/:id/pools` → `{ title?, targetCents, organizerMemberId, contributorMemberIds }`
  - `POST /groups/:id/loans` → `{ title?, lenderMemberId, borrowerMemberId, amountCents }`
  - `POST /groups/:id/orders` → `{ title?, payerMemberId, items: [{memberId, amountCents}] }`

- [ ] **Step 1: Write the failing test (append to `tests/api_test.ts`)**

```ts
async function makeGroupWithMembers(names: string[]) {
  const made = await (await handle(req("POST", "/groups", { title: "t" }), db)).json();
  const tok = { "x-settl-token": made.inviteToken };
  const { memberIds } = await (await handle(req("POST", `/groups/${made.groupId}/members`, { names }, tok), db)).json();
  return { groupId: made.groupId, tok, memberIds };
}

Deno.test("POST splits/pools/loans/orders each create an event", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, tok, memberIds } = await makeGroupWithMembers(["A", "B", "C"]);
  const [a, b, c] = memberIds;

  const split = await handle(req("POST", `/groups/${groupId}/splits`,
    { title: "din", totalCents: 2000, payerMemberId: a, shares: [{ memberId: b, amountCents: 1000 }, { memberId: c, amountCents: 1000 }] }, tok), db);
  assertEquals(split.status, 201);
  assert((await split.json()).eventId);

  const pool = await handle(req("POST", `/groups/${groupId}/pools`,
    { title: "cabin", targetCents: 6000, organizerMemberId: a, contributorMemberIds: [b, c] }, tok), db);
  assertEquals(pool.status, 201);

  const loan = await handle(req("POST", `/groups/${groupId}/loans`,
    { lenderMemberId: a, borrowerMemberId: b, amountCents: 500 }, tok), db);
  assertEquals(loan.status, 201);

  const order = await handle(req("POST", `/groups/${groupId}/orders`,
    { title: "boba", payerMemberId: a, items: [{ memberId: b, amountCents: 650 }] }, tok), db);
  assertEquals(order.status, 201);
});

Deno.test("a split with mismatched shares returns 400", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, tok, memberIds } = await makeGroupWithMembers(["A", "B"]);
  const [a, b] = memberIds;
  const bad = await handle(req("POST", `/groups/${groupId}/splits`,
    { totalCents: 1000, payerMemberId: a, shares: [{ memberId: b, amountCents: 900 }] }, tok), db);
  assertEquals(bad.status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/api_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — split/pool/loan/order routes return 404.

- [ ] **Step 3: Add the creation routes**

In `supabase/functions/api/router.ts`, extend the imports:
```ts
import {
  addMembers,
  claimMember,
  createGroup,
  createLoan,
  createOrder,
  createPool,
  createSplit,
  getNettedTransfers,
} from "../_shared/repo.ts";
```
Then inside the `if (parts[0] === "groups" && parts.length >= 3)` block, after the existing `balances` branch, add:
```ts
      if (req.method === "POST" && sub === "splits" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await createSplit(db, {
          groupId, title: b.title ?? null, totalCents: b.totalCents,
          payerMemberId: b.payerMemberId, shares: b.shares,
        });
        return json(out, 201);
      }

      if (req.method === "POST" && sub === "pools" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await createPool(db, {
          groupId, title: b.title ?? null, targetCents: b.targetCents,
          organizerMemberId: b.organizerMemberId, contributorMemberIds: b.contributorMemberIds,
        });
        return json(out, 201);
      }

      if (req.method === "POST" && sub === "loans" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await createLoan(db, {
          groupId, title: b.title ?? null, lenderMemberId: b.lenderMemberId,
          borrowerMemberId: b.borrowerMemberId, amountCents: b.amountCents,
        });
        return json(out, 201);
      }

      if (req.method === "POST" && sub === "orders" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await createOrder(db, {
          groupId, title: b.title ?? null, payerMemberId: b.payerMemberId, items: b.items,
        });
        return json(out, 201);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/api_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/router.ts tests/api_test.ts
git commit -m "feat: HTTP creation routes (splits, pools, loans, orders)"
```

---

### Task 13: HTTP settlement + confirm + void routes; README

**Files:**
- Modify: `supabase/functions/api/router.ts` (add route branches)
- Modify: `README.md` (document the API + how to run it)
- Test: `tests/api_test.ts` (append)

**Interfaces:**
- Produces (all require token):
  - `POST /groups/:id/settlements` → `{ fromMemberId, toMemberId, amountCents, method, idempotencyKey }` (key required) → 201 `{ settlementId }`
  - `POST /groups/:gid/settlements/:sid/confirm` → device header → 200 `{ ok: true }` (creditor-device gated)
  - `POST /groups/:gid/events/:eid/void` → 200 `{ ok: true }`

- [ ] **Step 1: Write the failing test (append to `tests/api_test.ts`)**

```ts
Deno.test("settlement record + creditor-device confirm over HTTP", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, tok, memberIds } = await makeGroupWithMembers(["A", "B"]);
  const [a, b] = memberIds;
  // A is creditor; A claims a device
  await handle(req("POST", `/groups/${groupId}/claim`, { memberId: a }, { ...tok, "x-settl-device": "dev-A" }), db);
  // B owes A 1000
  await handle(req("POST", `/groups/${groupId}/splits`,
    { totalCents: 1000, payerMemberId: a, shares: [{ memberId: b, amountCents: 1000 }] }, tok), db);

  const settle = await handle(req("POST", `/groups/${groupId}/settlements`,
    { fromMemberId: b, toMemberId: a, amountCents: 1000, method: "venmo", idempotencyKey: "k1" }, tok), db);
  assertEquals(settle.status, 201);
  const { settlementId } = await settle.json();

  // wrong device → 403
  const bad = await handle(req("POST", `/groups/${groupId}/settlements/${settlementId}/confirm`, {}, { ...tok, "x-settl-device": "dev-evil" }), db);
  assertEquals(bad.status, 403);

  // creditor device → 200, debt cleared
  const ok = await handle(req("POST", `/groups/${groupId}/settlements/${settlementId}/confirm`, {}, { ...tok, "x-settl-device": "dev-A" }), db);
  assertEquals(ok.status, 200);
  const bal = await (await handle(req("GET", `/groups/${groupId}/balances`, undefined, tok), db)).json();
  assertEquals(bal.transfers.length, 0);
});

Deno.test("POST /settlements without an idempotency key is rejected (400)", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, tok, memberIds } = await makeGroupWithMembers(["A", "B"]);
  const [a, b] = memberIds;
  await handle(req("POST", `/groups/${groupId}/splits`,
    { totalCents: 1000, payerMemberId: a, shares: [{ memberId: b, amountCents: 1000 }] }, tok), db);
  const res = await handle(req("POST", `/groups/${groupId}/settlements`,
    { fromMemberId: b, toMemberId: a, amountCents: 1000, method: "venmo" }, tok), db);
  assertEquals(res.status, 400);
});

Deno.test("void over HTTP reverses an event", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, tok, memberIds } = await makeGroupWithMembers(["A", "B"]);
  const [a, b] = memberIds;
  const { eventId } = await (await handle(req("POST", `/groups/${groupId}/splits`,
    { totalCents: 800, payerMemberId: a, shares: [{ memberId: b, amountCents: 800 }] }, tok), db)).json();
  const v = await handle(req("POST", `/groups/${groupId}/events/${eventId}/void`, {}, tok), db);
  assertEquals(v.status, 200);
  const bal = await (await handle(req("GET", `/groups/${groupId}/balances`, undefined, tok), db)).json();
  assertEquals(bal.transfers.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/api_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — settlement/confirm/void routes return 404.

- [ ] **Step 3: Add the routes + README**

In `supabase/functions/api/router.ts`, extend the imports to add `confirmSettlement`, `recordSettlement`, `voidEvent`:
```ts
import {
  addMembers,
  claimMember,
  confirmSettlement,
  createGroup,
  createLoan,
  createOrder,
  createPool,
  createSplit,
  getNettedTransfers,
  recordSettlement,
  voidEvent,
} from "../_shared/repo.ts";
```
Add a `POST /groups/:id/settlements` branch inside the `parts.length === 3` group block (alongside the creation routes):
```ts
      if (req.method === "POST" && sub === "settlements" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await recordSettlement(db, {
          groupId,
          fromMemberId: b.fromMemberId,
          toMemberId: b.toMemberId,
          amountCents: b.amountCents,
          method: b.method,
          idempotencyKey: b.idempotencyKey,
        });
        return json(out, 201);
      }
```
Then, after the `parts.length >= 3` group block, add handling for the 4-segment group routes (confirm and void). Place this block immediately before the final `return json({ error: "not found" }, 404);`:
```ts
    // /groups/:gid/settlements/:sid/confirm  and  /groups/:gid/events/:eid/void
    if (parts[0] === "groups" && parts.length === 5 && req.method === "POST") {
      const groupId = parts[1];
      await authorizeGroup(db, groupId, token);
      if (parts[2] === "settlements" && parts[4] === "confirm") {
        if (!device) throw new Error("missing device id");
        await confirmSettlement(db, { groupId, settlementId: parts[3], deviceId: device });
        return json({ ok: true }, 200);
      }
      if (parts[2] === "events" && parts[4] === "void") {
        await voidEvent(db, { groupId, eventId: parts[3] });
        return json({ ok: true }, 200);
      }
    }
```

Append to `README.md`:
```markdown

## API (Plan 2)

A single Supabase edge function (`supabase/functions/api`) serves the ledger over HTTP. Run locally:

```
supabase functions serve api --no-verify-jwt
```

Auth headers: `x-settl-token` (group invite token), `x-settl-device` (device id).

Routes:
- `POST /groups` → `{ groupId, inviteToken }`
- `POST /groups/:id/members` `{ names }` → `{ memberIds }`
- `POST /groups/:id/claim` `{ memberId, venmoHandle? }` (+ device) → `{ ok }`
- `GET  /groups/:id/balances` → `{ transfers }`
- `POST /groups/:id/splits | pools | loans | orders` → `{ eventId }`
- `POST /groups/:id/settlements` `{ fromMemberId, toMemberId, amountCents, method, idempotencyKey }` (key required) → `{ settlementId }`
- `POST /groups/:gid/settlements/:sid/confirm` (+ creditor device) → `{ ok }`
- `POST /groups/:gid/events/:eid/void` → `{ ok }`
```

- [ ] **Step 4: Run the FULL suite to verify everything is green**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno task test`
Expected: PASS — all suites (Plan 1's 30 + the new identity/flows/settlement2/api tests) green.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/router.ts tests/api_test.ts README.md
git commit -m "feat: HTTP settlement/confirm/void routes; document API in README"
```

---

## What this plan delivers

The full Settl backend behind an HTTP API: group creation with invite tokens, member seats with atomic first-come device claiming, all four creation flows (split, pool, loan, group-order) over the generalized atomic `create_event` writer, event voiding, settlement recording hardened with a per-group advisory lock + idempotency keys, and creditor-device-gated confirmation — all reachable through one edge function whose handler is unit-tested end-to-end against a real local Supabase.

## Explicitly out of scope (later plans)

- **Pool progress visualization** (target vs collected) — Plan 4 (extension), pending a decision on tagging settlements with an `event_id`.
- **Web settle page** for non-users — Plan 3.
- **SwiftUI iMessage extension** — Plan 4.
- **Rate limiting / abuse protection** beyond the group-token gate — revisit before any public exposure.
