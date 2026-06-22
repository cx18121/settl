# Settl — Design Spec

*Working name: **Settl**. An iMessage app for settling up and chasing money between friends. (Note: an unrelated "Settl: Split" exists on the App Store, so the public store-listing name will need a tweak at submission — not blocking; this is the internal working name.)*

Date: 2026-06-17 · Status: approved design, pre-implementation

---

## What this is

A group-money manager that lives inside an iMessage conversation. The job it does well is the one that actually hurts: **settling up and chasing** — keeping an accurate shared ledger of who owes who, netting it down to the fewest payments, and doing the awkward nagging so no human has to be the nag.

It is **not** crypto, not a wallet, not a bank. Money moves through apps people already have (Venmo). The app's value is the ledger + the netting + absorbing the social awkwardness of asking for money back.

### How we got here (so future-me doesn't re-litigate)

This supersedes a prior ETHGlobal-hackathon spec (`~/Documents/Claude/Projects/ethglobal hackathon/SPEC.md`) that described a web-app + iMessage-relay + on-chain-USDC architecture. That framing was driven by hackathon prize tracks and is **dead**. The hackathon (June 12–14 2026) has passed; goal now is **a real product Charlie can actually use with friends**. Architecture was reconsidered from scratch.

Decisions locked during this brainstorm:

1. **Core job = settling up / chasing** (not bill-splitting per se — splitting is just one way debts get created).
2. **Money rails = deep-link to Venmo.** No crypto, no custody, no KYC, no smart contracts. (Apple Cash *cannot* be deep-linked — verified against Apple Developer Forums — so it's manual-only. Cash App could be added later; left out of v1 by Charlie's call: Venmo one-tap only.)
3. **Surface = iMessage app extension only.** No companion app, no push notifications in v1.
4. **Identity = no accounts.** Device-generated ID + a typed Venmo handle. People self-identify ("claim") because Apple anonymizes iMessage participants.

---

## Why extension-only, no companion (the load-bearing constraint)

An iMessage app extension ships **inside** a regular iOS app bundle, so it's **one App Store download** — the extension just appears in the Messages drawer. Nobody installs two things. People who only *owe* money install **nothing** (they get a web link).

A companion app's *only* unique capability is **receiving push notifications** (extensions can't register for or receive remote push, and have no background execution). Everything else — split/pool UI, balances, talking to a backend, Venmo deep-links, drafting reminders — works in the extension alone.

Dropping the companion means the app is **pull-based**: it can't proactively tap anyone on the shoulder; it helps the moment you open it in a chat. That fits how chasing actually happens (you open the group chat to text them anyway). The cost is "no unprompted 9am reminder." If that's ever missed, a thin companion app can be added later as pure additive (push becomes v2) with **no change** to the backend or extension.

---

## Architecture

```
iPhone (installed user)
  iMessage Extension  (the entire app — no companion, no push)
    • Split / Pool creation     • Netted group balances
    • Settle → Venmo deep link  • "Remind [Send]" → inserts an iMessage
        │ HTTPS (URLSession)
        ▼
  Thin backend (Supabase: Postgres + Edge Functions)
    • Shared ledger = source of truth   • Netting computation
    • Serves the web settle pages
        │ public link in a normal text
        ▼
  Web settle page (no install required)
    • "You owe Charlie $14"   • [Pay with Venmo]
```

- **One target**: the iMessage extension. It ships inside a minimal host-app shell (so the App Store has something to list); the user never meaningfully sees the host app, and it does not register for push.
- **Backend is required** (not optional): a multi-person ledger needs one source of truth, and the web settle page must be served from somewhere.
- **Stack**: Swift + SwiftUI (`MSMessagesAppViewController`) · Supabase Postgres + Edge Functions (TypeScript) · netting logic lives **once** in the backend as source of truth · web settle page = one minimal route.

---

## The core insight: two primitives, not five features

Everything Charlie asked for reduces to entries in one shared ledger (*A owes B $X for reason R*):

| Asked for | Actually is |
|---|---|
| Split an expense | One payer fronts a cost, divided equal/custom → N shares |
| Group order | A custom split with a per-person *item* entry screen → same shares |
| Loan | A split of one, A→B, no division → one share |
| Trip pool | A *collection toward a target*: organizer + N shares + a progress bar |

So there are **two creation flows** — **Split** (equal/custom, with a group-order item mode) and **Pool** (target + progress). Loans are Split-of-one. That's the entire feature surface.

---

## Data model (Supabase / Postgres)

Five tables. Net balances are **computed**, never stored.

- **groups** — one per iMessage conversation. `(id, title, invite_token, created_at)`. `invite_token` is a random secret minted at creation that lives in the share/deep link (see Identity & authorization).
- **members** — a named person in a group. `(id, group_id, display_name, venmo_handle, device_id nullable, claimed bool)`
  - *Claim flow:* the extension only sees opaque, per-device participant UUIDs (Apple anonymizes participants — no names, no numbers). So the creator types names; when another person opens the bubble they tap "I'm Jake" to bind their `device_id`. This sidesteps Apple's anonymization.
- **events** — a split/pool/loan/order. `(id, group_id, type, title, total_cents, payer_member_id, target_cents nullable, created_at, voided bool)`
- **shares** — what each member owes toward an event. `(id, event_id, member_id, amount_cents, paid bool)`
- **settlements** — a payment between two members. `(id, group_id, from_member_id, to_member_id, amount_cents, method, status, idempotency_key nullable, created_at)` where `method ∈ {venmo, apple_cash, cash, other}` and `status ∈ {proposed, confirmed}`. `idempotency_key` is a client-supplied key (unique per group) so a retried request can't double-count the same payment.

**Net balance** of a member = (shares they owe) − (shares others owe them, where they were payer) − (settlements they've made) + (settlements made to them). The netting function reduces all net positions to the **minimum set of transfers** (greedy: largest debtor ↔ largest creditor).

**Identity & authorization (no accounts).** Per the locked decision, there are no user accounts. Authorization rests on two things: a per-group **invite token** (a random secret minted at group creation, carried in the share/deep link) and a per-device **device-id** (generated on first use). The model is deliberately light because the trust model is *social* — money never moves without someone tapping Venmo, and every ledger entry is group-visible and disputable, so the worst case is a wrong number, not theft.
- **Being in the group = being invited.** Any caller presenting the correct `(group_id, invite_token)` may read the group, create events (split/pool/loan/order), record settlements, and void events. This mirrors "anyone in the group can log who owes who."
- **Claiming a seat** binds a `device_id` to a `members` row **first-come**: the first device to claim an unclaimed seat owns it; a different device trying to claim an already-claimed seat is rejected. Re-claiming from the same device is idempotent (e.g. to update a Venmo handle).
- **Device binding gates the one sensitive op:** confirming a Venmo settlement's receipt requires the caller's device to be the one bound to the **creditor** (`to_member`) — the "creditor authorizes" rule deferred from the ledger-core phase. Everything else only needs the group token.
- **Concurrency:** settlement recording runs under a per-group advisory lock plus a client idempotency key, so concurrent or retried submissions can't double-count a payment; at most one `proposed` settlement per debtor→creditor pair is enforced by a partial unique index.

---

## Flows

**Create split.** Open extension in a chat → "New split" → enter total, pick equal / custom / by-item (group-order mode), assign to typed names → backend writes event + shares → extension inserts a card bubble: *"Charlie paid $40 · you owe $10 · [Open]."* Others tap the bubble → extension opens to the group → claim their seat first time → see *"you owe Charlie $10 · [Pay]."*

**Pool.** "New pool" → title + target (or $/person × N) → event type `pool` → card shows a progress bar (*$150 / $800*); each member taps [Pay] → Venmo to the organizer → progress updates.

**Settle up.** Open group → *"You owe Charlie $14 (netted across 3 things)"* → [Pay with Venmo] builds the prefilled charge (`venmo://paycharge?txn=pay&recipients=<handle>&amount=14&note=<escaped>`) → back in app, confirm → settlement recorded (`proposed`); creditor confirms receipt → `confirmed`. Apple Cash / cash → "I paid another way" → manual mark (`method=apple_cash|cash|other`, auto-`confirmed`).

**Chase (pull-based).** Open the chat → app surfaces *"Jake owes you $14, 6 days — [Remind]"* → tap **inserts a ready-to-send iMessage** (with the web settle link) into the current conversation → you tap send. Jake (no app) taps the link → web settle page → [Pay with Venmo]. The extension can only insert into the conversation you're currently in (it can't DM arbitrary people) — which is where chasing naturally happens.

---

## Edge cases & correctness

- **Rounding** — $10/3 distributes leftover cents deterministically (first members get the extra cent); shares always sum **exactly** to the total. No created or lost pennies.
- **Events are immutable** — editing = void + recreate, keeping the ledger auditable. Voiding reverses that event's shares.
- **Partial payments** — a settlement may be less than owed; the remainder stays open.
- **Never optimistic about money** — the extension shows "pending" until the backend confirms a write; balances are never shown as settled before the server agrees. Failed writes queue + retry.
- **Unclaimed / left-the-group members** — their named seat persists; the web link still works; the creditor can always mark manually.
- **No Venmo installed** — the `https://venmo.com/...` web link opens the app or browser; otherwise fall back to manual mark.

**Trust model.** Anyone in the group can log "X owes Y," so every entry is **visible to the whole group and disputable** (void/dispute affordance). Because *no money moves without the payer choosing to tap Venmo*, the worst case is a wrong number everyone can see and correct — not a theft.

---

## Testing (intent, not just behavior)

- **Netting** — pure function, property-tested: net positions always sum to zero, and computed transfers settle *everyone* in the minimum count. This is the financial heart; a bug here = wrong money asks.
- **Rounding** — splits always sum to the exact total.
- **Settlement state machine** — proposed→confirmed, partials, voids reverse correctly.
- **Venmo deep-link** — URL built + escaped correctly against the verified format.
- **Web settle page** — token resolves to the correct owed amount.
- **Extension UI** — lighter manual/snapshot coverage; the real logic lives in the testable backend.

---

## v1 scope

**In:** split (equal/custom), group order (by-item split), loan (split-of-one), trip pool (target + progress), netted balances, Venmo one-tap settle, manual mark-as-paid (Apple Cash/cash/other), pull-based chasing via drafted reminders, web settle page for non-users.

**Explicitly cut (so the spec is honest):** snap-a-receipt AI itemizing, push / companion app, bets / prediction markets, multiple one-tap rails (Cash App etc.), on-chain / escrow / USDC, agent-to-agent settlement, standing-policy automation.

## Open questions (not blocking)

- Product name: **Settl** is the working name; revisit the public App Store listing name at submission (collision with existing "Settl: Split").
- Settlement confirmation: does the creditor have to confirm receipt, or does the payer's "I paid" auto-confirm? (Lean: payer marks → creditor gets a soft "confirm?" but it's not blocking.)
- Whether the web settle page is served by a Supabase Edge Function or a tiny separate static host.
