# Settl

An iMessage app for tracking shared expenses and settling up with friends.

The backend tracks group balances, reduces debts to a set of payments, and serves read-only
settlement pages with Venmo links. The iMessage extension currently supports connecting to an
existing group, claiming a member, and viewing balances. Settl does not move money itself.

This is a work in progress for local development, not a production-ready service.

## Project layout

- `ios/Settl` contains the host app.
- `ios/SettlMessages` contains the iMessage extension.
- `ios/SettlKit` contains the Swift API client and models.
- `supabase/functions` contains the TypeScript API and ledger logic.
- `supabase/migrations` contains the database schema and functions.
- `tests` contains the backend tests.

## Local development

### Backend

Install Deno and the Supabase CLI. Supabase's local stack also needs a Docker-compatible runtime.
Run these commands from the repository root.

```sh
supabase start
supabase functions serve api --no-verify-jwt
```

The API is available at `http://127.0.0.1:54321/functions/v1/api`. It uses group invite tokens and
device IDs rather than Supabase user JWTs.

### Tests

The pure ledger tests do not need a database.

```sh
deno task test:unit
```

The full backend suite writes test data. Use only a disposable local Supabase instance, never a
production database. In a separate terminal, use the local service-role key shown by
`supabase status`.

```sh
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_SERVICE_ROLE_KEY="<local service_role key>"
deno task test
```

Keep credentials in your environment or an ignored `.env` file. Do not commit them. Deno tasks do
not automatically load `.env` files.

### iOS

Install Xcode and XcodeGen, then generate the Xcode project.

```sh
(cd ios && xcodegen generate)
open ios/Settl.xcodeproj
```

The API client defaults to the local backend on `127.0.0.1`, suitable for the iOS Simulator. A
physical device needs a reachable backend URL configured in
`ios/SettlKit/Sources/SettlKit/Config.swift`. Configure your own signing team and bundle identifiers
for device builds.

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

Settlement links use a separate per-member token, not the group invite token. Treat both kinds of
links as private.

## Before deployment

Publishing the source does not make the backend safe to expose. The current migrations do not
enable row-level security. The backend assumes database access is restricted to its service role.
Before deploying, restrict direct Data API access to ledger tables and functions, verify that
unauthenticated clients cannot read or mutate them, and keep service-role credentials server-side.
