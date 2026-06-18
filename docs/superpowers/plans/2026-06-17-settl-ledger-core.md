# Settl Ledger Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and fully test the financial core of Settl — split math, debt netting, balance computation, and settlement recording — plus the Postgres schema it maps to, so all money logic is proven before any UI exists.

**Architecture:** Pure, deterministic TypeScript modules (no I/O) hold the money math and are exhaustively unit/property tested. A thin service layer maps those modules onto a Supabase Postgres schema and is integration-tested against a local Supabase stack. No HTTP, no UI, no auth in this plan — those come in later plans (API, web settle page, iMessage extension).

**Tech Stack:** Supabase (Postgres + CLI for local dev), TypeScript on Deno (the Supabase Edge Functions runtime), `deno test` as the test runner, `@supabase/supabase-js` for DB access in the service layer.

## Global Constraints

- **All money is integer cents** (`number`). Never use floats/dollars for amounts anywhere in code or DB. DB money columns are `bigint` (cents).
- **Splits must sum exactly to the total** — no created or lost pennies. Rounding remainder goes to the first members deterministically.
- **Events are immutable** — never UPDATE an event's amounts; "editing" = mark `voided = true` and create a new event. Voided events are excluded from all balance math.
- **Only `confirmed` settlements affect balances.** `proposed` settlements do not.
- **Net positions of a group always sum to zero** — this is a test invariant, not just a goal.
- Deno standard library asserts imported from `jsr:@std/assert@1`.
- Local Supabase is driven by the Supabase CLI (`supabase start` / `supabase stop`); migrations live in `supabase/migrations/` as timestamped SQL.

---

### Task 1: Project scaffold (Supabase + Deno test)

**Files:**
- Create: `deno.json`
- Create: `supabase/` (via `supabase init`)
- Create: `.gitignore` (append)
- Create: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a `deno test` task and a local Supabase project other tasks rely on.

- [ ] **Step 1: Initialize Supabase project structure**

Run:
```bash
cd /Users/charliexue/School/cs_misc/settl
supabase init
```
Expected: creates `supabase/config.toml` and `supabase/` subfolders. If `supabase` is not installed, install via `brew install supabase/tap/supabase` first.

- [ ] **Step 2: Create `deno.json` with test + lint tasks and the std import**

```json
{
  "tasks": {
    "test": "deno test --allow-env --allow-net --allow-read",
    "test:unit": "deno test tests/splitMath_test.ts tests/netting_test.ts tests/balances_test.ts"
  },
  "imports": {
    "@std/assert": "jsr:@std/assert@1",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2"
  },
  "fmt": { "useTabs": false, "lineWidth": 100 }
}
```

- [ ] **Step 3: Append build artifacts to `.gitignore`**

Append these lines to `.gitignore`:
```
# Supabase / Deno
.branches
.temp
supabase/.temp
```

- [ ] **Step 4: Write a placeholder README**

Create `README.md`:
```markdown
# Settl

iMessage app for settling up and chasing group money. See `docs/superpowers/specs/2026-06-17-imessage-group-money-design.md`.

## Dev
- `supabase start` — local Postgres + Studio
- `deno task test` — run all tests
```

- [ ] **Step 5: Verify Deno runs and commit**

Run: `deno task test`
Expected: PASS with "No test modules found" (0 tests) — confirms Deno + deno.json are valid.

```bash
git add -A
git commit -m "chore: scaffold supabase + deno test setup"
```

---

### Task 2: Database schema migration

**Files:**
- Create: `supabase/migrations/0001_init.sql`
- Test: `tests/schema_test.ts`

**Interfaces:**
- Consumes: local Supabase from Task 1.
- Produces: tables `groups`, `members`, `events`, `shares`, `settlements` with the columns the service layer (Tasks 7–9) reads/writes.

- [ ] **Step 1: Write the schema migration**

Create `supabase/migrations/0001_init.sql`:
```sql
create table groups (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  display_name text not null,
  venmo_handle text,
  device_id text,
  claimed boolean not null default false,
  created_at timestamptz not null default now()
);

create table events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  type text not null check (type in ('split','pool','loan','order')),
  title text,
  total_cents bigint not null check (total_cents >= 0),
  payer_member_id uuid not null references members(id),
  target_cents bigint check (target_cents >= 0),
  voided boolean not null default false,
  created_at timestamptz not null default now()
);

create table shares (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  member_id uuid not null references members(id),
  amount_cents bigint not null check (amount_cents >= 0),
  paid boolean not null default false
);

create table settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  from_member_id uuid not null references members(id),
  to_member_id uuid not null references members(id),
  amount_cents bigint not null check (amount_cents > 0),
  method text not null check (method in ('venmo','apple_cash','cash','other')),
  status text not null default 'proposed' check (status in ('proposed','confirmed')),
  created_at timestamptz not null default now()
);

create index on members(group_id);
create index on events(group_id);
create index on shares(event_id);
create index on settlements(group_id);
```

- [ ] **Step 2: Start Supabase and apply the migration**

Run:
```bash
supabase start
supabase migration up
```
Expected: `supabase start` prints local API URL + anon/service keys; `migration up` applies `0001_init` with no error.

- [ ] **Step 3: Write a test that the tables exist**

Create `tests/schema_test.ts`:
```ts
import { assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";

const url = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.test("core tables exist and are queryable", async () => {
  const db = createClient(url, key);
  for (const table of ["groups", "members", "events", "shares", "settlements"]) {
    const { error } = await db.from(table).select("*").limit(1);
    assertEquals(error, null, `table ${table} should be queryable`);
  }
});
```

- [ ] **Step 4: Run the test with the local service key**

Run (substitute the service_role key printed by `supabase start`, or read it from `supabase status`):
```bash
SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/schema_test.ts --allow-env --allow-net
```
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0001_init.sql tests/schema_test.ts
git commit -m "feat: initial ledger schema (groups, members, events, shares, settlements)"
```

---

### Task 3: Equal-split math with deterministic rounding

**Files:**
- Create: `supabase/functions/_shared/types.ts`
- Create: `supabase/functions/_shared/splitMath.ts`
- Test: `tests/splitMath_test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Cents = number`
  - `interface ShareInput { memberId: string; amountCents: Cents }`
  - `function equalSplit(totalCents: Cents, memberIds: string[]): ShareInput[]`

- [ ] **Step 1: Write the failing test**

Create `tests/splitMath_test.ts`:
```ts
import { assertEquals, assertThrows } from "@std/assert";
import { equalSplit } from "../supabase/functions/_shared/splitMath.ts";

Deno.test("equalSplit divides evenly when divisible", () => {
  const shares = equalSplit(900, ["a", "b", "c"]);
  assertEquals(shares.map((s) => s.amountCents), [300, 300, 300]);
});

Deno.test("equalSplit gives remainder cents to first members", () => {
  const shares = equalSplit(1000, ["a", "b", "c"]);
  assertEquals(shares.map((s) => s.amountCents), [334, 333, 333]);
});

Deno.test("equalSplit always sums to total", () => {
  for (const total of [1, 7, 99, 100, 1001, 99999]) {
    for (const n of [1, 2, 3, 4, 7]) {
      const ids = Array.from({ length: n }, (_, i) => `m${i}`);
      const sum = equalSplit(total, ids).reduce((a, s) => a + s.amountCents, 0);
      assertEquals(sum, total, `total ${total} across ${n}`);
    }
  }
});

Deno.test("equalSplit rejects empty member list", () => {
  assertThrows(() => equalSplit(100, []), Error, "at least one member");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/splitMath_test.ts --allow-read`
Expected: FAIL — cannot find module `splitMath.ts`.

- [ ] **Step 3: Write the types and implementation**

Create `supabase/functions/_shared/types.ts`:
```ts
export type Cents = number;

export interface ShareInput {
  memberId: string;
  amountCents: Cents;
}

export interface NetPosition {
  memberId: string;
  cents: Cents; // positive = is owed money, negative = owes money
}

export interface Transfer {
  fromMemberId: string;
  toMemberId: string;
  amountCents: Cents;
}
```

Create `supabase/functions/_shared/splitMath.ts`:
```ts
import type { Cents, ShareInput } from "./types.ts";

export function equalSplit(totalCents: Cents, memberIds: string[]): ShareInput[] {
  if (memberIds.length === 0) throw new Error("equalSplit needs at least one member");
  const n = memberIds.length;
  const base = Math.floor(totalCents / n);
  let remainder = totalCents - base * n; // 0..n-1 extra cents
  return memberIds.map((memberId) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { memberId, amountCents: base + extra };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/splitMath_test.ts --allow-read`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/types.ts supabase/functions/_shared/splitMath.ts tests/splitMath_test.ts
git commit -m "feat: equalSplit with deterministic cent rounding"
```

---

### Task 4: Custom-split validation

**Files:**
- Modify: `supabase/functions/_shared/splitMath.ts`
- Test: `tests/splitMath_test.ts` (append)

**Interfaces:**
- Consumes: `ShareInput`, `Cents` from Task 3.
- Produces: `function assertSharesSumTo(totalCents: Cents, shares: ShareInput[]): void` (throws on mismatch or negative amounts).

- [ ] **Step 1: Write the failing test (append to `tests/splitMath_test.ts`)**

```ts
import { assertSharesSumTo } from "../supabase/functions/_shared/splitMath.ts";

Deno.test("assertSharesSumTo passes when shares match total", () => {
  assertSharesSumTo(1000, [
    { memberId: "a", amountCents: 600 },
    { memberId: "b", amountCents: 400 },
  ]);
});

Deno.test("assertSharesSumTo throws when shares miss total", () => {
  assertThrows(
    () => assertSharesSumTo(1000, [{ memberId: "a", amountCents: 999 }]),
    Error,
    "must sum to total",
  );
});

Deno.test("assertSharesSumTo throws on negative share", () => {
  assertThrows(
    () =>
      assertSharesSumTo(1000, [
        { memberId: "a", amountCents: 1100 },
        { memberId: "b", amountCents: -100 },
      ]),
    Error,
    "negative",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/splitMath_test.ts --allow-read`
Expected: FAIL — `assertSharesSumTo` is not exported.

- [ ] **Step 3: Implement (append to `supabase/functions/_shared/splitMath.ts`)**

```ts
export function assertSharesSumTo(totalCents: Cents, shares: ShareInput[]): void {
  for (const s of shares) {
    if (s.amountCents < 0) throw new Error(`share for ${s.memberId} is negative`);
  }
  const sum = shares.reduce((a, s) => a + s.amountCents, 0);
  if (sum !== totalCents) {
    throw new Error(`shares must sum to total: got ${sum}, expected ${totalCents}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/splitMath_test.ts --allow-read`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/splitMath.ts tests/splitMath_test.ts
git commit -m "feat: custom-split sum validation"
```

---

### Task 5: Debt-netting engine (minimal transfers)

**Files:**
- Create: `supabase/functions/_shared/netting.ts`
- Test: `tests/netting_test.ts`

**Interfaces:**
- Consumes: `NetPosition`, `Transfer`, `Cents` from Task 3's `types.ts`.
- Produces: `function minimalTransfers(positions: NetPosition[]): Transfer[]` — given net positions (which must sum to zero), returns a set of transfers that zeroes everyone, at most `n-1` transfers.

- [ ] **Step 1: Write the failing test**

Create `tests/netting_test.ts`:
```ts
import { assertEquals } from "@std/assert";
import { minimalTransfers } from "../supabase/functions/_shared/netting.ts";
import type { NetPosition, Transfer } from "../supabase/functions/_shared/types.ts";

function applyTransfers(positions: NetPosition[], transfers: Transfer[]): Map<string, number> {
  const net = new Map(positions.map((p) => [p.memberId, p.cents]));
  for (const t of transfers) {
    net.set(t.fromMemberId, (net.get(t.fromMemberId) ?? 0) + t.amountCents);
    net.set(t.toMemberId, (net.get(t.toMemberId) ?? 0) - t.amountCents);
  }
  return net;
}

Deno.test("simple two-party debt nets to one transfer", () => {
  const positions: NetPosition[] = [
    { memberId: "a", cents: -1000 }, // a owes
    { memberId: "b", cents: 1000 }, // b is owed
  ];
  const transfers = minimalTransfers(positions);
  assertEquals(transfers, [{ fromMemberId: "a", toMemberId: "b", amountCents: 1000 }]);
});

Deno.test("everyone ends at zero after applying transfers", () => {
  const positions: NetPosition[] = [
    { memberId: "a", cents: -700 },
    { memberId: "b", cents: -300 },
    { memberId: "c", cents: 1000 },
  ];
  const transfers = minimalTransfers(positions);
  for (const [, v] of applyTransfers(positions, transfers)) assertEquals(v, 0);
});

Deno.test("produces at most n-1 transfers", () => {
  const positions: NetPosition[] = [
    { memberId: "a", cents: -500 },
    { memberId: "b", cents: -500 },
    { memberId: "c", cents: 400 },
    { memberId: "d", cents: 600 },
  ];
  const transfers = minimalTransfers(positions);
  assertEquals(transfers.length <= 3, true);
  for (const [, v] of applyTransfers(positions, transfers)) assertEquals(v, 0);
});

Deno.test("all-settled positions produce no transfers", () => {
  const positions: NetPosition[] = [
    { memberId: "a", cents: 0 },
    { memberId: "b", cents: 0 },
  ];
  assertEquals(minimalTransfers(positions), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/netting_test.ts --allow-read`
Expected: FAIL — cannot find module `netting.ts`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/netting.ts`:
```ts
import type { NetPosition, Transfer } from "./types.ts";

export function minimalTransfers(positions: NetPosition[]): Transfer[] {
  const total = positions.reduce((a, p) => a + p.cents, 0);
  if (total !== 0) throw new Error(`net positions must sum to zero, got ${total}`);

  // debtors have negative cents, creditors positive; ignore the already-settled
  const debtors = positions.filter((p) => p.cents < 0).map((p) => ({ ...p }));
  const creditors = positions.filter((p) => p.cents > 0).map((p) => ({ ...p }));
  debtors.sort((a, b) => a.cents - b.cents); // most-negative first
  creditors.sort((a, b) => b.cents - a.cents); // most-positive first

  const transfers: Transfer[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debt = -debtors[i].cents;
    const credit = creditors[j].cents;
    const amount = Math.min(debt, credit);
    transfers.push({
      fromMemberId: debtors[i].memberId,
      toMemberId: creditors[j].memberId,
      amountCents: amount,
    });
    debtors[i].cents += amount;
    creditors[j].cents -= amount;
    if (debtors[i].cents === 0) i++;
    if (creditors[j].cents === 0) j++;
  }
  return transfers;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/netting_test.ts --allow-read`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/netting.ts tests/netting_test.ts
git commit -m "feat: minimal-transfer debt netting engine"
```

---

### Task 6: Balance computation from events, shares, settlements

**Files:**
- Create: `supabase/functions/_shared/balances.ts`
- Test: `tests/balances_test.ts`

**Interfaces:**
- Consumes: `NetPosition`, `Cents` from `types.ts`.
- Produces:
  - `interface EventRow { id: string; payerMemberId: string; voided: boolean }`
  - `interface ShareRow { eventId: string; memberId: string; amountCents: Cents }`
  - `interface SettlementRow { fromMemberId: string; toMemberId: string; amountCents: Cents; status: "proposed" | "confirmed" }`
  - `function netPositions(events: EventRow[], shares: ShareRow[], settlements: SettlementRow[]): NetPosition[]`

- [ ] **Step 1: Write the failing test**

Create `tests/balances_test.ts`:
```ts
import { assertEquals } from "@std/assert";
import { netPositions } from "../supabase/functions/_shared/balances.ts";

Deno.test("one split: non-payers owe the payer", () => {
  const events = [{ id: "e1", payerMemberId: "a", voided: false }];
  const shares = [
    { eventId: "e1", memberId: "b", amountCents: 1000 },
    { eventId: "e1", memberId: "c", amountCents: 1000 },
  ];
  const pos = netPositions(events, shares, []);
  const byId = Object.fromEntries(pos.map((p) => [p.memberId, p.cents]));
  assertEquals(byId, { a: 2000, b: -1000, c: -1000 });
});

Deno.test("confirmed settlement reduces the debt", () => {
  const events = [{ id: "e1", payerMemberId: "a", voided: false }];
  const shares = [{ eventId: "e1", memberId: "b", amountCents: 1000 }];
  const settlements = [
    { fromMemberId: "b", toMemberId: "a", amountCents: 1000, status: "confirmed" as const },
  ];
  const pos = netPositions(events, shares, settlements);
  const byId = Object.fromEntries(pos.map((p) => [p.memberId, p.cents]));
  assertEquals(byId, { a: 0, b: 0 });
});

Deno.test("proposed settlement does NOT affect balances", () => {
  const events = [{ id: "e1", payerMemberId: "a", voided: false }];
  const shares = [{ eventId: "e1", memberId: "b", amountCents: 1000 }];
  const settlements = [
    { fromMemberId: "b", toMemberId: "a", amountCents: 1000, status: "proposed" as const },
  ];
  const pos = netPositions(events, shares, settlements);
  const byId = Object.fromEntries(pos.map((p) => [p.memberId, p.cents]));
  assertEquals(byId, { a: 1000, b: -1000 });
});

Deno.test("voided event is ignored", () => {
  const events = [{ id: "e1", payerMemberId: "a", voided: true }];
  const shares = [{ eventId: "e1", memberId: "b", amountCents: 1000 }];
  assertEquals(netPositions(events, shares, []), []);
});

Deno.test("net positions always sum to zero", () => {
  const events = [
    { id: "e1", payerMemberId: "a", voided: false },
    { id: "e2", payerMemberId: "b", voided: false },
  ];
  const shares = [
    { eventId: "e1", memberId: "b", amountCents: 700 },
    { eventId: "e1", memberId: "c", amountCents: 300 },
    { eventId: "e2", memberId: "a", amountCents: 500 },
  ];
  const settlements = [
    { fromMemberId: "c", toMemberId: "a", amountCents: 100, status: "confirmed" as const },
  ];
  const sum = netPositions(events, shares, settlements).reduce((a, p) => a + p.cents, 0);
  assertEquals(sum, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/balances_test.ts --allow-read`
Expected: FAIL — cannot find module `balances.ts`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/balances.ts`:
```ts
import type { Cents, NetPosition } from "./types.ts";

export interface EventRow {
  id: string;
  payerMemberId: string;
  voided: boolean;
}
export interface ShareRow {
  eventId: string;
  memberId: string;
  amountCents: Cents;
}
export interface SettlementRow {
  fromMemberId: string;
  toMemberId: string;
  amountCents: Cents;
  status: "proposed" | "confirmed";
}

export function netPositions(
  events: EventRow[],
  shares: ShareRow[],
  settlements: SettlementRow[],
): NetPosition[] {
  const payerByEvent = new Map(events.filter((e) => !e.voided).map((e) => [e.id, e.payerMemberId]));
  const net = new Map<string, Cents>();
  const add = (id: string, c: Cents) => net.set(id, (net.get(id) ?? 0) + c);

  for (const s of shares) {
    const payer = payerByEvent.get(s.eventId);
    if (payer === undefined) continue; // event voided or unknown
    if (s.memberId === payer) continue; // payer doesn't owe themselves
    add(s.memberId, -s.amountCents); // debtor owes
    add(payer, s.amountCents); // payer is owed
  }
  for (const st of settlements) {
    if (st.status !== "confirmed") continue;
    add(st.fromMemberId, st.amountCents); // paying reduces your debt
    add(st.toMemberId, -st.amountCents); // receiving reduces what you're owed
  }
  return [...net.entries()].map(([memberId, cents]) => ({ memberId, cents }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/balances_test.ts --allow-read`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/balances.ts tests/balances_test.ts
git commit -m "feat: net-position balance computation"
```

---

### Task 7: Service layer — create a split event in the DB

**Files:**
- Create: `supabase/functions/_shared/db.ts`
- Create: `supabase/functions/_shared/repo.ts`
- Test: `tests/repo_test.ts`

**Interfaces:**
- Consumes: `equalSplit`, `assertSharesSumTo` (Task 3/4), `@supabase/supabase-js`.
- Produces:
  - `function makeDb(): SupabaseClient` (reads `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from env)
  - `interface CreateSplitInput { groupId: string; title: string | null; totalCents: number; payerMemberId: string; shares: { memberId: string; amountCents: number }[] }`
  - `async function createSplit(db, input: CreateSplitInput): Promise<{ eventId: string }>` — validates shares sum to total, inserts one `events` row (type `split`) and its `shares` rows.

- [ ] **Step 1: Write the failing test**

Create `tests/repo_test.ts`:
```ts
import { assertEquals, assert } from "@std/assert";
import { makeDb } from "../supabase/functions/_shared/db.ts";
import { createSplit } from "../supabase/functions/_shared/repo.ts";

async function seedGroupWithMembers(db: ReturnType<typeof makeDb>, names: string[]) {
  const { data: g } = await db.from("groups").insert({ title: "test" }).select().single();
  const { data: members } = await db
    .from("members")
    .insert(names.map((n) => ({ group_id: g!.id, display_name: n })))
    .select();
  return { groupId: g!.id as string, members: members! as { id: string; display_name: string }[] };
}

Deno.test("createSplit inserts event + shares that sum to total", async () => {
  const db = makeDb();
  const { groupId, members } = await seedGroupWithMembers(db, ["A", "B", "C"]);
  const [a, b, c] = members;

  const { eventId } = await createSplit(db, {
    groupId,
    title: "Dinner",
    totalCents: 3000,
    payerMemberId: a.id,
    shares: [
      { memberId: b.id, amountCents: 1500 },
      { memberId: c.id, amountCents: 1500 },
    ],
  });

  assert(eventId);
  const { data: ev } = await db.from("events").select("*").eq("id", eventId).single();
  assertEquals(ev!.type, "split");
  assertEquals(Number(ev!.total_cents), 3000);

  const { data: shares } = await db.from("shares").select("*").eq("event_id", eventId);
  assertEquals(shares!.reduce((s, r) => s + Number(r.amount_cents), 0), 3000);
});

Deno.test("createSplit rejects shares that do not sum to total", async () => {
  const db = makeDb();
  const { groupId, members } = await seedGroupWithMembers(db, ["A", "B"]);
  let threw = false;
  try {
    await createSplit(db, {
      groupId,
      title: "Bad",
      totalCents: 1000,
      payerMemberId: members[0].id,
      shares: [{ memberId: members[1].id, amountCents: 900 }],
    });
  } catch (e) {
    threw = (e as Error).message.includes("sum to total");
  }
  assertEquals(threw, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/repo_test.ts --allow-env --allow-net --allow-read` (with the `SUPABASE_SERVICE_ROLE_KEY` env set as in Task 2 Step 4)
Expected: FAIL — cannot find module `db.ts`.

- [ ] **Step 3: Write the db client and repo**

Create `supabase/functions/_shared/db.ts`:
```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function makeDb(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  return createClient(url, key);
}
```

Create `supabase/functions/_shared/repo.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSharesSumTo } from "./splitMath.ts";

export interface CreateSplitInput {
  groupId: string;
  title: string | null;
  totalCents: number;
  payerMemberId: string;
  shares: { memberId: string; amountCents: number }[];
}

export async function createSplit(
  db: SupabaseClient,
  input: CreateSplitInput,
): Promise<{ eventId: string }> {
  assertSharesSumTo(
    input.totalCents,
    input.shares.map((s) => ({ memberId: s.memberId, amountCents: s.amountCents })),
  );

  const { data: ev, error: evErr } = await db
    .from("events")
    .insert({
      group_id: input.groupId,
      type: "split",
      title: input.title,
      total_cents: input.totalCents,
      payer_member_id: input.payerMemberId,
    })
    .select()
    .single();
  if (evErr) throw new Error(`createSplit event insert: ${evErr.message}`);

  const { error: shErr } = await db.from("shares").insert(
    input.shares.map((s) => ({
      event_id: ev!.id,
      member_id: s.memberId,
      amount_cents: s.amountCents,
    })),
  );
  if (shErr) throw new Error(`createSplit shares insert: ${shErr.message}`);

  return { eventId: ev!.id as string };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/repo_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/db.ts supabase/functions/_shared/repo.ts tests/repo_test.ts
git commit -m "feat: createSplit service writes event + shares with validation"
```

---

### Task 8: Service layer — netted balances for a group

**Files:**
- Modify: `supabase/functions/_shared/repo.ts`
- Test: `tests/repo_test.ts` (append)

**Interfaces:**
- Consumes: `netPositions` (Task 6), `minimalTransfers` (Task 5), `createSplit` (Task 7).
- Produces: `async function getNettedTransfers(db, groupId: string): Promise<Transfer[]>` — loads events/shares/settlements for the group, computes net positions, returns minimal transfers.

- [ ] **Step 1: Write the failing test (append to `tests/repo_test.ts`)**

```ts
import { getNettedTransfers } from "../supabase/functions/_shared/repo.ts";

Deno.test("getNettedTransfers returns who-pays-whom for a group", async () => {
  const db = makeDb();
  const { groupId, members } = await seedGroupWithMembers(db, ["A", "B", "C"]);
  const [a, b, c] = members;
  // A pays 30, split B/C 15 each → B owes A 15, C owes A 15
  await createSplit(db, {
    groupId,
    title: "Dinner",
    totalCents: 3000,
    payerMemberId: a.id,
    shares: [
      { memberId: b.id, amountCents: 1500 },
      { memberId: c.id, amountCents: 1500 },
    ],
  });

  const transfers = await getNettedTransfers(db, groupId);
  // both debtors pay A; 2 transfers, each 1500, all to A
  assertEquals(transfers.length, 2);
  for (const t of transfers) {
    assertEquals(t.toMemberId, a.id);
    assertEquals(t.amountCents, 1500);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/repo_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `getNettedTransfers` is not exported.

- [ ] **Step 3: Implement (append to `supabase/functions/_shared/repo.ts`)**

```ts
import { netPositions, type EventRow, type ShareRow, type SettlementRow } from "./balances.ts";
import { minimalTransfers } from "./netting.ts";
import type { Transfer } from "./types.ts";

export async function getNettedTransfers(
  db: SupabaseClient,
  groupId: string,
): Promise<Transfer[]> {
  const { data: events, error: e1 } = await db
    .from("events")
    .select("id, payer_member_id, voided")
    .eq("group_id", groupId);
  if (e1) throw new Error(`getNettedTransfers events: ${e1.message}`);

  const eventIds = (events ?? []).map((e) => e.id);
  const { data: shares, error: e2 } = eventIds.length
    ? await db.from("shares").select("event_id, member_id, amount_cents").in("event_id", eventIds)
    : { data: [], error: null };
  if (e2) throw new Error(`getNettedTransfers shares: ${e2.message}`);

  const { data: settlements, error: e3 } = await db
    .from("settlements")
    .select("from_member_id, to_member_id, amount_cents, status")
    .eq("group_id", groupId);
  if (e3) throw new Error(`getNettedTransfers settlements: ${e3.message}`);

  const eventRows: EventRow[] = (events ?? []).map((e) => ({
    id: e.id,
    payerMemberId: e.payer_member_id,
    voided: e.voided,
  }));
  const shareRows: ShareRow[] = (shares ?? []).map((s) => ({
    eventId: s.event_id,
    memberId: s.member_id,
    amountCents: Number(s.amount_cents),
  }));
  const settlementRows: SettlementRow[] = (settlements ?? []).map((s) => ({
    fromMemberId: s.from_member_id,
    toMemberId: s.to_member_id,
    amountCents: Number(s.amount_cents),
    status: s.status,
  }));

  return minimalTransfers(netPositions(eventRows, shareRows, settlementRows));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/repo_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/repo.ts tests/repo_test.ts
git commit -m "feat: getNettedTransfers loads group ledger and nets it"
```

---

### Task 9: Service layer — record and confirm a settlement

**Files:**
- Modify: `supabase/functions/_shared/repo.ts`
- Test: `tests/repo_test.ts` (append)

**Interfaces:**
- Consumes: `createSplit`, `getNettedTransfers` (Tasks 7–8).
- Produces:
  - `interface RecordSettlementInput { groupId: string; fromMemberId: string; toMemberId: string; amountCents: number; method: "venmo" | "apple_cash" | "cash" | "other" }`
  - `async function recordSettlement(db, input): Promise<{ settlementId: string }>` — inserts a `proposed` settlement (or `confirmed` immediately when `method !== "venmo"`, since manual marks are self-confirmed per spec).
  - `async function confirmSettlement(db, settlementId: string): Promise<void>` — sets status to `confirmed`.

- [ ] **Step 1: Write the failing test (append to `tests/repo_test.ts`)**

```ts
import { recordSettlement, confirmSettlement } from "../supabase/functions/_shared/repo.ts";

Deno.test("confirmed settlement clears the netted debt", async () => {
  const db = makeDb();
  const { groupId, members } = await seedGroupWithMembers(db, ["A", "B"]);
  const [a, b] = members;
  await createSplit(db, {
    groupId,
    title: "Loan",
    totalCents: 2000,
    payerMemberId: a.id,
    shares: [{ memberId: b.id, amountCents: 2000 }],
  });
  // before: B owes A 2000
  assertEquals((await getNettedTransfers(db, groupId)).length, 1);

  const { settlementId } = await recordSettlement(db, {
    groupId,
    fromMemberId: b.id,
    toMemberId: a.id,
    amountCents: 2000,
    method: "venmo",
  });
  // venmo settlement starts 'proposed' → still owed until confirmed
  assertEquals((await getNettedTransfers(db, groupId)).length, 1);

  await confirmSettlement(db, settlementId);
  assertEquals((await getNettedTransfers(db, groupId)).length, 0);
});

Deno.test("manual (cash) settlement is confirmed immediately", async () => {
  const db = makeDb();
  const { groupId, members } = await seedGroupWithMembers(db, ["A", "B"]);
  const [a, b] = members;
  await createSplit(db, {
    groupId, title: "x", totalCents: 1000, payerMemberId: a.id,
    shares: [{ memberId: b.id, amountCents: 1000 }],
  });
  await recordSettlement(db, {
    groupId, fromMemberId: b.id, toMemberId: a.id, amountCents: 1000, method: "cash",
  });
  assertEquals((await getNettedTransfers(db, groupId)).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/repo_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — `recordSettlement` is not exported.

- [ ] **Step 3: Implement (append to `supabase/functions/_shared/repo.ts`)**

```ts
export interface RecordSettlementInput {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amountCents: number;
  method: "venmo" | "apple_cash" | "cash" | "other";
}

export async function recordSettlement(
  db: SupabaseClient,
  input: RecordSettlementInput,
): Promise<{ settlementId: string }> {
  if (input.amountCents <= 0) throw new Error("settlement amount must be positive");
  // Venmo settlements await the recipient's confirmation; manual marks are self-confirmed.
  const status = input.method === "venmo" ? "proposed" : "confirmed";
  const { data, error } = await db
    .from("settlements")
    .insert({
      group_id: input.groupId,
      from_member_id: input.fromMemberId,
      to_member_id: input.toMemberId,
      amount_cents: input.amountCents,
      method: input.method,
      status,
    })
    .select()
    .single();
  if (error) throw new Error(`recordSettlement: ${error.message}`);
  return { settlementId: data!.id as string };
}

export async function confirmSettlement(db: SupabaseClient, settlementId: string): Promise<void> {
  const { error } = await db
    .from("settlements")
    .update({ status: "confirmed" })
    .eq("id", settlementId);
  if (error) throw new Error(`confirmSettlement: ${error.message}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/repo_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the FULL suite and commit**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno task test`
Expected: PASS — all unit + schema + repo tests green.

```bash
git add supabase/functions/_shared/repo.ts tests/repo_test.ts
git commit -m "feat: record/confirm settlements; manual marks self-confirm"
```

---

## What this plan delivers

A fully-tested money engine: equal/custom split math with exact-cent rounding, minimal-transfer netting, balance computation honoring voids and confirmed-vs-proposed settlements, and a DB-backed service layer (`createSplit`, `getNettedTransfers`, `recordSettlement`, `confirmSettlement`) — all green against a local Supabase. No HTTP, UI, pools, claim flow, or auth yet.

## Follow-on plans (not in scope here)

- **Plan 2 — API + pools + claim flow:** edge-function HTTP handlers over the service layer; `createPool` (event type `pool`, everyone owes the organizer toward `target_cents`) and `createLoan` (split-of-one); member claim/self-identify; void-event endpoint.
- **Plan 3 — Web settle page:** token-addressed edge function returning HTML showing a member's netted amount owed + Venmo deep links.
- **Plan 4 — iMessage extension:** SwiftUI `MSMessagesAppViewController`, split/pool entry, balance cards, message bubbles, Venmo deep-linking, drafted-reminder insertion.
