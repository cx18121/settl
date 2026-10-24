# Settl

An iMessage app for settling up with friends. It tracks shared expenses, works out who owes who,
and links to Venmo for payments.

## Project layout

- `ios/Settl`: host app
- `ios/SettlMessages`: iMessage extension
- `ios/SettlKit`: Swift API client and models
- `supabase/functions`: TypeScript API and ledger logic
- `supabase/migrations`: database schema and functions
- `tests`: backend tests

## Local development

### Backend

You'll need Deno, the Supabase CLI, and Docker or a compatible runtime.

From the repo root:

```sh
supabase start
supabase functions serve api --no-verify-jwt
```

The API runs at `http://127.0.0.1:54321/functions/v1/api`. Auth uses group invite tokens and device IDs.

### Tests

Ledger tests, no database needed:

```sh
deno task test:unit
```

For the full suite, keep local Supabase running and open another terminal. Get the local
service-role key from `supabase status`:

```sh
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_SERVICE_ROLE_KEY="<local service_role key>"
deno task test
```

If you use a `.env` file, load it into your shell first. The test task doesn't load it automatically.

### iOS

With Xcode and XcodeGen installed:

```sh
(cd ios && xcodegen generate)
open ios/Settl.xcodeproj
```

The Simulator uses the local backend by default. For a physical device, change the URL in
`ios/SettlKit/Sources/SettlKit/Config.swift` and set your signing team and bundle identifiers in Xcode.

Run the Swift package tests with `swift test --package-path ios/SettlKit`.

## API

Group routes other than group creation use `x-settl-token` for the invite token. Claiming a member,
recording or confirming a settlement, and voiding an event also use `x-settl-device` for the device ID.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/groups` | Create a group and invite token |
| GET | `/groups/:id/members` | List members and claim status |
| POST | `/groups/:id/members` | Add named members |
| POST | `/groups/:id/claim` | Claim a member for a device |
| GET | `/groups/:id/balances` | Get netted transfers |
| POST | `/groups/:id/splits` | Record a shared expense |
| POST | `/groups/:id/pools` | Record a pool |
| POST | `/groups/:id/loans` | Record a loan |
| POST | `/groups/:id/orders` | Record a group order |
| POST | `/groups/:id/settlements` | Record a payment with an idempotency key |
| POST | `/groups/:gid/settlements/:sid/confirm` | Confirm receipt as the creditor |
| POST | `/groups/:gid/events/:eid/void` | Void an event as a claimed member |
| GET | `/settle/:groupId/:memberId?t=<settleToken>` | View a read-only settlement page |
