# Settl

An iMessage app for tracking shared expenses and settling up through Venmo.

## Project layout

- `ios/Settl`: host app
- `ios/SettlMessages`: iMessage extension
- `ios/SettlKit`: Swift API client and models
- `supabase/functions`: TypeScript API and ledger logic
- `supabase/migrations`: database schema and functions
- `tests`: backend tests

## Local development

### Backend

Requires Deno, the Supabase CLI, and Docker or a compatible runtime.

Run from the repo root:

```sh
supabase start
supabase functions serve api --no-verify-jwt
```

The API runs at `http://127.0.0.1:54321/functions/v1/api`. Auth uses group invite tokens and device IDs.

### Tests

Run the ledger tests without a database:

```sh
deno task test:unit
```

The full suite runs against local Supabase. In a separate terminal, set the service-role key
from `supabase status`:

```sh
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_SERVICE_ROLE_KEY="<local service_role key>"
deno task test
```

Load any `.env` file into the shell before running tests. The test task does not load it automatically.

### iOS

Requires Xcode and XcodeGen. Generate and open the project:

```sh
(cd ios && xcodegen generate)
open ios/Settl.xcodeproj
```

The iOS Simulator uses the local backend by default. Physical device builds require a reachable
backend URL in `ios/SettlKit/Sources/SettlKit/Config.swift` and a signing team and bundle identifiers
configured in Xcode.

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
