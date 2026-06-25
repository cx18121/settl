# Settl

iMessage app for settling up and chasing group money. See `docs/superpowers/specs/2026-06-17-imessage-group-money-design.md`.

## Dev
- `supabase start` — local Postgres + Studio
- `deno task test` — run all tests

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
- `GET  /settle/:groupId/:memberId?t=<settleToken>` → `200 text/html` — public, no-install settle page (read-only): shows the member's netted balance and a Venmo pay link. Bad link → `404 text/html`. Uses a per-member `settle_token`, not the group token.
