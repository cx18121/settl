# iMessage Extension — Slice 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the full stack end-to-end — a SwiftUI iMessage extension calls the Supabase HTTP API to list members, claim a seat by device id, and show netted balances.

**Architecture:** Two backend additions (prefix-tolerant routing so a served `/functions/v1/api/...` path resolves; a read-only `GET /groups/:id/members`). Then a new `ios/` XcodeGen project with a host app, an `MSMessagesAppExtension`, and a Foundation-only `SettlKit` Swift package holding all testable logic (models, API client, device id). The extension hosts SwiftUI via `UIHostingController`. SettlKit is unit-tested with `swift test`; the app + extension are compile-verified with `xcodebuild`; the UI is verified manually.

**Tech Stack:** Deno + Supabase (backend); Swift 6, SwiftUI, Messages framework, XCTest, XcodeGen 2.45.4, Xcode 26 / iOS 26 simulator (client).

## Global Constraints

- **Default ZERO comments in all code (TS and Swift), including tests** (repo Rule 9). A comment is acceptable only for genuinely complex logic whose intent can't be deduced, explaining WHY not WHAT. Header/docblocks, section labels, and narration never qualify.
- **Backend** changes follow the existing patterns: service-role only (no RLS/grants), error-message prefixes like `listMembers: ...`, DB tests set `{ sanitizeResources: false, sanitizeOps: false }`.
- **Backend full test command** (local Supabase running via `supabase start`):
  `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno task test`
- **`SettlKit` is Foundation-only** — no `import UIKit`, `import Messages`, or `import SwiftUI`. All Messages/SwiftUI code lives in the extension/app targets. This is what keeps `swift test` headless.
- **The generated `ios/Settl.xcodeproj` is git-ignored** (already in `.gitignore`); `ios/project.yml` is the committed source of truth.
- **Bundle ids:** host `com.charliexue.settl`, extension `com.charliexue.settl.messages` (extension id must be prefixed by the host id).
- **iOS deployment target 17.0.** Simulator target: `iPhone 17` (an available iOS 26.4 sim).
- **Test fixtures are grounded, not invented:** the JSON in decode tests mirrors the exact shapes the backend returns (`repo.ts`); verify against a live `curl` when seeding for the manual check.

---

## File Structure

Backend (existing dir):
- Modify: `supabase/functions/api/router.ts` — prefix-tolerant routing + `GET members` branch.
- Modify: `supabase/functions/_shared/repo.ts` — `listMembers`.
- Modify: `tests/api_test.ts` — routing + members tests.

Client (new `ios/` dir):
```
ios/
  project.yml
  Settl/                 App.swift, ContentView.swift, Info.plist
  SettlMessages/         MessagesViewController.swift, RootView.swift, ConnectView.swift,
                         GroupView.swift, GroupViewModel.swift, ConnectionStore.swift, Info.plist
  SettlKit/
    Package.swift
    Sources/SettlKit/    Models.swift, Config.swift, DeviceID.swift, APIClient.swift
    Tests/SettlKitTests/ ModelsTests.swift, DeviceIDTests.swift, APIClientTests.swift
```

---

### Task 1: Prefix-tolerant routing (backend)

**Files:**
- Modify: `supabase/functions/api/router.ts`
- Test: `tests/api_test.ts`

**Interfaces:**
- Produces: `handle` resolves routes relative to an optional `.../api` prefix, so a served path `/functions/v1/api/groups/:id/balances` matches the same as `/groups/:id/balances`. Bare paths (no `api` segment) are unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/api_test.ts`:

```typescript
Deno.test("routes resolve under a /functions/v1/api prefix", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const made = await (await handle(req("POST", "/functions/v1/api/groups", { title: "t" }), db)).json();
  assert(made.groupId && made.inviteToken);
  const tok = { "x-settl-token": made.inviteToken };
  const bal = await handle(req("GET", `/functions/v1/api/groups/${made.groupId}/balances`, undefined, tok), db);
  assertEquals(bal.status, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/api_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — the prefixed POST falls through to `{ error: "not found" }` 404, so `made.groupId` is undefined.

- [ ] **Step 3: Make routing prefix-tolerant**

In `supabase/functions/api/router.ts`, inside `handle`, replace:

```typescript
  const parts = url.pathname.split("/").filter(Boolean);
```

with:

```typescript
  const rawParts = url.pathname.split("/").filter(Boolean);
  const apiIdx = rawParts.lastIndexOf("api");
  const parts = apiIdx >= 0 ? rawParts.slice(apiIdx + 1) : rawParts;
```

(Group/member/event ids are UUIDs and the settle route uses `settle`, so no real path segment equals `api`; bare test paths have no `api` segment and are unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/api_test.ts --allow-env --allow-net --allow-read`
Expected: PASS (all existing api tests still pass + the new one).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/router.ts tests/api_test.ts
git commit -m "feat: prefix-tolerant routing so served /functions/v1/api paths resolve"
```

---

### Task 2: GET /groups/:id/members (backend)

**Files:**
- Modify: `supabase/functions/_shared/repo.ts`
- Modify: `supabase/functions/api/router.ts`
- Test: `tests/api_test.ts`

**Interfaces:**
- Consumes: existing `authorizeGroup`.
- Produces:
  - `listMembers(db, groupId): Promise<{ id: string; displayName: string; claimed: boolean }[]>`
  - Route `GET /groups/:id/members` → `200 [{ id, displayName, claimed }]`, group-token-gated. Returns identity + claimed only (no device_id, no settle_token).

- [ ] **Step 1: Write the failing test**

Add to `tests/api_test.ts`:

```typescript
Deno.test("GET /groups/:id/members lists seats with claimed state, token-gated", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { groupId, tok, memberIds } = await makeGroupWithMembers(["Charlie", "Jake"]);
  await handle(req("POST", `/groups/${groupId}/claim`, { memberId: memberIds[0] }, { ...tok, "x-settl-device": "dev-C" }), db);

  const noTok = await handle(req("GET", `/groups/${groupId}/members`), db);
  assertEquals(noTok.status, 403);

  const res = await handle(req("GET", `/groups/${groupId}/members`, undefined, tok), db);
  assertEquals(res.status, 200);
  const members = await res.json();
  assertEquals(members.length, 2);
  const charlie = members.find((m: { displayName: string }) => m.displayName === "Charlie");
  const jake = members.find((m: { displayName: string }) => m.displayName === "Jake");
  assertEquals(charlie.claimed, true);
  assertEquals(jake.claimed, false);
  assertEquals(Object.keys(charlie).sort(), ["claimed", "displayName", "id"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno test tests/api_test.ts --allow-env --allow-net --allow-read`
Expected: FAIL — GET members falls through to 404 (route not defined).

- [ ] **Step 3: Add `listMembers` to `repo.ts`**

Append to `supabase/functions/_shared/repo.ts`:

```typescript
export async function listMembers(
  db: SupabaseClient,
  groupId: string,
): Promise<{ id: string; displayName: string; claimed: boolean }[]> {
  const { data, error } = await db
    .from("members")
    .select("id, display_name, claimed")
    .eq("group_id", groupId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listMembers: ${error.message}`);
  return (data ?? []).map((m) => ({
    id: m.id as string,
    displayName: m.display_name as string,
    claimed: m.claimed as boolean,
  }));
}
```

- [ ] **Step 4: Add the route to `router.ts`**

Add `listMembers` to the existing `../_shared/repo.ts` import list. Then add this branch inside the `if (parts[0] === "groups" && parts.length >= 3)` block, next to the `balances` GET branch:

```typescript
      if (req.method === "GET" && sub === "members" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const members = await listMembers(db, groupId);
        return json(members, 200);
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')" deno task test`
Expected: PASS — full suite green (existing + the new members test).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/repo.ts supabase/functions/api/router.ts tests/api_test.ts
git commit -m "feat: GET /groups/:id/members (read-only seats + claimed state)"
```

---

### Task 3: iOS scaffold — XcodeGen project that compiles for the simulator

**Files:**
- Create: `ios/project.yml`, `ios/Settl/App.swift`, `ios/Settl/ContentView.swift`, `ios/SettlMessages/MessagesViewController.swift`, `ios/SettlMessages/RootView.swift`, `ios/SettlKit/Package.swift`, `ios/SettlKit/Sources/SettlKit/Placeholder.swift`, `ios/SettlKit/Tests/SettlKitTests/PlaceholderTests.swift`
- Generated by `xcodegen` from `project.yml` (committed, regenerate identically): `ios/Settl/Info.plist`, `ios/SettlMessages/Info.plist`. Do NOT hand-author these — they come from each target's `info.properties` block below.

This is scaffolding; its deliverable is "the project generates and compiles, and `swift test` runs." There is no failing-test-first; the gate is the build.

- [ ] **Step 1: Create the SettlKit package**

`ios/SettlKit/Package.swift`:

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SettlKit",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "SettlKit", targets: ["SettlKit"])],
    targets: [
        .target(name: "SettlKit"),
        .testTarget(name: "SettlKitTests", dependencies: ["SettlKit"]),
    ]
)
```

`ios/SettlKit/Sources/SettlKit/Placeholder.swift`:

```swift
public enum SettlKit {
    public static let name = "SettlKit"
}
```

`ios/SettlKit/Tests/SettlKitTests/PlaceholderTests.swift`:

```swift
import XCTest
@testable import SettlKit

final class PlaceholderTests: XCTestCase {
    func testNameIsSet() {
        XCTAssertEqual(SettlKit.name, "SettlKit")
    }
}
```

- [ ] **Step 2: Run the package test to confirm the package is valid**

Run: `cd ios/SettlKit && swift test`
Expected: PASS (1 test). Then `cd ../..`.

- [ ] **Step 3: Create the host app sources**

`ios/Settl/App.swift`:

```swift
import SwiftUI

@main
struct SettlApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
```

`ios/Settl/ContentView.swift`:

```swift
import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Settl")
                .font(.largeTitle.bold())
            Text("Open Settl inside a Messages conversation.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}
```

(The `Info.plist` is generated by XcodeGen from `project.yml` in Step 5 — do not author it here.)

- [ ] **Step 4: Create the extension sources**

`ios/SettlMessages/MessagesViewController.swift`:

```swift
import UIKit
import Messages
import SwiftUI

final class MessagesViewController: MSMessagesAppViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: RootView())
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
    }
}
```

For this scaffold step, add a temporary minimal `RootView` so the extension compiles (replaced in Task 7). Create `ios/SettlMessages/RootView.swift`:

```swift
import SwiftUI

struct RootView: View {
    var body: some View {
        Text("Settl")
    }
}
```

(The extension's `Info.plist` — including the `NSExtension` keys and the ATS local-networking exception — is generated by XcodeGen from `project.yml` in Step 5.)

- [ ] **Step 5: Create `ios/project.yml`**

```yaml
name: Settl
options:
  bundleIdPrefix: com.charliexue
  deploymentTarget:
    iOS: "17.0"
packages:
  SettlKit:
    path: SettlKit
targets:
  Settl:
    type: application
    platform: iOS
    sources: [Settl]
    info:
      path: Settl/Info.plist
      properties:
        UILaunchScreen: {}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.charliexue.settl
    dependencies:
      - target: SettlMessages
        embed: true
    scheme: {}
  SettlMessages:
    type: app-extension.messages
    platform: iOS
    sources: [SettlMessages]
    info:
      path: SettlMessages/Info.plist
      properties:
        NSExtension:
          NSExtensionPointIdentifier: com.apple.message-payload-provider
          NSExtensionPrincipalClass: $(PRODUCT_MODULE_NAME).MessagesViewController
        NSAppTransportSecurity:
          NSAllowsLocalNetworking: true
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.charliexue.settl.messages
    dependencies:
      - package: SettlKit
        product: SettlKit
    scheme: {}
```

XcodeGen writes these two `Info.plist` files from the `info.properties` blocks and sets `INFOPLIST_FILE` for each target. They are committed (regenerate identically); the `.xcodeproj` is git-ignored.

- [ ] **Step 6: Generate and build**

Run:
```bash
cd ios && xcodegen generate && \
xcodebuild -project Settl.xcodeproj -scheme Settl \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -15 ; cd ..
```
Expected: `** BUILD SUCCEEDED **`. If XcodeGen keys need adjustment for this Xcode version, iterate `project.yml` until the build succeeds (the build is the gate). Do not change the targets' types or bundle ids.

- [ ] **Step 7: Commit**

```bash
git add ios/project.yml ios/Settl ios/SettlMessages ios/SettlKit
git commit -m "feat: ios scaffold — host app + iMessage extension + SettlKit (compiles for sim)"
```

---

### Task 4: SettlKit Models

**Files:**
- Create: `ios/SettlKit/Sources/SettlKit/Models.swift`
- Test: `ios/SettlKit/Tests/SettlKitTests/ModelsTests.swift`
- Delete: `ios/SettlKit/Sources/SettlKit/Placeholder.swift` and `ios/SettlKit/Tests/SettlKitTests/PlaceholderTests.swift` (replaced by real types/tests)

**Interfaces:**
- Produces:
  - `public struct Transfer: Codable, Equatable { public let fromMemberId, toMemberId: String; public let amountCents: Int }`
  - `public struct MemberSummary: Codable, Equatable { public let id, displayName: String; public let claimed: Bool }`
  - `public struct BalancesResponse: Codable, Equatable { public let transfers: [Transfer] }`
  - JSON keys are camelCase, matching the API output verbatim.

- [ ] **Step 1: Write the failing test**

Create `ios/SettlKit/Tests/SettlKitTests/ModelsTests.swift`:

```swift
import XCTest
@testable import SettlKit

final class ModelsTests: XCTestCase {
    func testDecodesMembersArray() throws {
        let json = Data("""
        [{"id":"11111111-1111-1111-1111-111111111111","displayName":"Charlie","claimed":true},
         {"id":"22222222-2222-2222-2222-222222222222","displayName":"Jake","claimed":false}]
        """.utf8)
        let members = try JSONDecoder().decode([MemberSummary].self, from: json)
        XCTAssertEqual(members.count, 2)
        XCTAssertEqual(members[0].displayName, "Charlie")
        XCTAssertTrue(members[0].claimed)
        XCTAssertFalse(members[1].claimed)
    }

    func testDecodesBalancesResponse() throws {
        let json = Data("""
        {"transfers":[{"fromMemberId":"22222222-2222-2222-2222-222222222222",
                       "toMemberId":"11111111-1111-1111-1111-111111111111","amountCents":1400}]}
        """.utf8)
        let res = try JSONDecoder().decode(BalancesResponse.self, from: json)
        XCTAssertEqual(res.transfers.count, 1)
        XCTAssertEqual(res.transfers[0].amountCents, 1400)
        XCTAssertEqual(res.transfers[0].toMemberId, "11111111-1111-1111-1111-111111111111")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios/SettlKit && swift test 2>&1 | tail -15 ; cd ../..`
Expected: FAIL — `MemberSummary`/`Transfer`/`BalancesResponse` are undefined (compile error).

- [ ] **Step 3: Write the models, remove placeholders**

Delete `ios/SettlKit/Sources/SettlKit/Placeholder.swift` and `ios/SettlKit/Tests/SettlKitTests/PlaceholderTests.swift`.

Create `ios/SettlKit/Sources/SettlKit/Models.swift`:

```swift
import Foundation

public struct Transfer: Codable, Equatable {
    public let fromMemberId: String
    public let toMemberId: String
    public let amountCents: Int
}

public struct MemberSummary: Codable, Equatable, Identifiable {
    public let id: String
    public let displayName: String
    public let claimed: Bool
}

public struct BalancesResponse: Codable, Equatable {
    public let transfers: [Transfer]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios/SettlKit && swift test 2>&1 | tail -15 ; cd ../..`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ios/SettlKit/Sources/SettlKit/Models.swift ios/SettlKit/Tests/SettlKitTests/ModelsTests.swift
git rm ios/SettlKit/Sources/SettlKit/Placeholder.swift ios/SettlKit/Tests/SettlKitTests/PlaceholderTests.swift
git commit -m "feat(SettlKit): API Codable models (Transfer, MemberSummary, BalancesResponse)"
```

---

### Task 5: SettlKit DeviceID

**Files:**
- Create: `ios/SettlKit/Sources/SettlKit/DeviceID.swift`
- Test: `ios/SettlKit/Tests/SettlKitTests/DeviceIDTests.swift`

**Interfaces:**
- Produces:
  - `public protocol KeyValueStore { func string(forKey key: String) -> String?; func set(_ value: String, forKey key: String) }`
  - `extension UserDefaults: KeyValueStore {}`
  - `public struct DeviceID { public init(store: KeyValueStore); public func current() -> String }` — returns a persisted per-install UUID, generating + storing it on first call only.

- [ ] **Step 1: Write the failing test**

Create `ios/SettlKit/Tests/SettlKitTests/DeviceIDTests.swift`:

```swift
import XCTest
@testable import SettlKit

private final class MemoryStore: KeyValueStore {
    private var dict: [String: String] = [:]
    func string(forKey key: String) -> String? { dict[key] }
    func set(_ value: String, forKey key: String) { dict[key] = value }
}

final class DeviceIDTests: XCTestCase {
    func testGeneratesOnceAndPersists() {
        let store = MemoryStore()
        let first = DeviceID(store: store).current()
        XCTAssertFalse(first.isEmpty)
        let second = DeviceID(store: store).current()
        XCTAssertEqual(first, second)
    }

    func testDistinctStoresGiveDistinctIds() {
        let a = DeviceID(store: MemoryStore()).current()
        let b = DeviceID(store: MemoryStore()).current()
        XCTAssertNotEqual(a, b)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios/SettlKit && swift test 2>&1 | tail -15 ; cd ../..`
Expected: FAIL — `KeyValueStore`/`DeviceID` undefined.

- [ ] **Step 3: Write the implementation**

Create `ios/SettlKit/Sources/SettlKit/DeviceID.swift`:

```swift
import Foundation

public protocol KeyValueStore {
    func string(forKey key: String) -> String?
    func set(_ value: String, forKey key: String)
}

extension UserDefaults: KeyValueStore {
    public func set(_ value: String, forKey key: String) {
        setValue(value, forKey: key)
    }
}

public struct DeviceID {
    private static let key = "settl.deviceId"
    private let store: KeyValueStore

    public init(store: KeyValueStore) {
        self.store = store
    }

    public func current() -> String {
        if let existing = store.string(forKey: Self.key) {
            return existing
        }
        let fresh = UUID().uuidString
        store.set(fresh, forKey: Self.key)
        return fresh
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios/SettlKit && swift test 2>&1 | tail -15 ; cd ../..`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add ios/SettlKit/Sources/SettlKit/DeviceID.swift ios/SettlKit/Tests/SettlKitTests/DeviceIDTests.swift
git commit -m "feat(SettlKit): persistent per-install DeviceID"
```

---

### Task 6: SettlKit APIClient + Config

**Files:**
- Create: `ios/SettlKit/Sources/SettlKit/Config.swift`, `ios/SettlKit/Sources/SettlKit/APIClient.swift`
- Test: `ios/SettlKit/Tests/SettlKitTests/APIClientTests.swift`

**Interfaces:**
- Consumes: `MemberSummary`, `Transfer`, `BalancesResponse`.
- Produces:
  - `public struct APIConfig { public let baseURL: URL; public let inviteToken: String; public let deviceID: String; public init(...) }`
  - `public enum Config { public static let localBaseURL = URL(string: "http://127.0.0.1:54321/functions/v1/api")! }`
  - `public enum APIError: Error, Equatable { case unauthorized; case conflict; case server(Int); case decoding }`
  - `public struct APIClient { public init(config: APIConfig, session: URLSession = .shared); public func members(groupId: String) async throws -> [MemberSummary]; public func balances(groupId: String) async throws -> [Transfer]; public func claim(groupId: String, memberId: String) async throws }`
  - Every request sets headers `x-settl-token` (inviteToken) and `x-settl-device` (deviceID). `members`/`balances` are GET; `claim` is POST with JSON body `{"memberId": "..."}`. Non-2xx → 401/403 `.unauthorized`, 409 `.conflict`, else `.server(status)`.

- [ ] **Step 1: Write the failing test**

Create `ios/SettlKit/Tests/SettlKitTests/APIClientTests.swift`:

```swift
import XCTest
@testable import SettlKit

final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = StubURLProtocol.handler else {
            fatalError("no handler set")
        }
        let (response, data) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func stubbedClient(
    handler: @escaping (URLRequest) -> (HTTPURLResponse, Data),
) -> APIClient {
    StubURLProtocol.handler = handler
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    let session = URLSession(configuration: cfg)
    let apiCfg = APIConfig(
        baseURL: URL(string: "http://x/functions/v1/api")!,
        inviteToken: "tok-123",
        deviceID: "dev-abc",
    )
    return APIClient(config: apiCfg, session: session)
}

private func ok(_ url: URL, _ body: String) -> (HTTPURLResponse, Data) {
    (HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
}

final class APIClientTests: XCTestCase {
    func testMembersSendsHeadersAndDecodes() async throws {
        var seen: URLRequest?
        let client = stubbedClient { req in
            seen = req
            return ok(req.url!, """
            [{"id":"m1","displayName":"Jake","claimed":false}]
            """)
        }
        let members = try await client.members(groupId: "g1")
        XCTAssertEqual(members, [MemberSummary(id: "m1", displayName: "Jake", claimed: false)])
        XCTAssertEqual(seen?.httpMethod, "GET")
        XCTAssertEqual(seen?.url?.path, "/functions/v1/api/groups/g1/members")
        XCTAssertEqual(seen?.value(forHTTPHeaderField: "x-settl-token"), "tok-123")
        XCTAssertEqual(seen?.value(forHTTPHeaderField: "x-settl-device"), "dev-abc")
    }

    func testBalancesUnwrapsTransfers() async throws {
        let client = stubbedClient { req in
            ok(req.url!, """
            {"transfers":[{"fromMemberId":"a","toMemberId":"b","amountCents":1400}]}
            """)
        }
        let transfers = try await client.balances(groupId: "g1")
        XCTAssertEqual(transfers, [Transfer(fromMemberId: "a", toMemberId: "b", amountCents: 1400)])
    }

    func testClaimPostsMemberId() async throws {
        var seen: URLRequest?
        let client = stubbedClient { req in
            seen = req
            return ok(req.url!, "{\"ok\":true}")
        }
        try await client.claim(groupId: "g1", memberId: "m1")
        XCTAssertEqual(seen?.httpMethod, "POST")
        XCTAssertEqual(seen?.url?.path, "/functions/v1/api/groups/g1/claim")
    }

    func testConflictMapsToConflictError() async {
        let client = stubbedClient { req in
            (HTTPURLResponse(url: req.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!,
             Data("{\"error\":\"already claimed\"}".utf8))
        }
        do {
            try await client.claim(groupId: "g1", memberId: "m1")
            XCTFail("expected throw")
        } catch let e as APIError {
            XCTAssertEqual(e, .conflict)
        }
    }

    func testForbiddenMapsToUnauthorized() async {
        let client = stubbedClient { req in
            (HTTPURLResponse(url: req.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!,
             Data("{\"error\":\"unauthorized\"}".utf8))
        }
        do {
            _ = try await client.members(groupId: "g1")
            XCTFail("expected throw")
        } catch let e as APIError {
            XCTAssertEqual(e, .unauthorized)
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios/SettlKit && swift test 2>&1 | tail -20 ; cd ../..`
Expected: FAIL — `APIConfig`/`APIClient`/`APIError` undefined.

- [ ] **Step 3: Write Config and APIClient**

Create `ios/SettlKit/Sources/SettlKit/Config.swift`:

```swift
import Foundation

public enum Config {
    public static let localBaseURL = URL(string: "http://127.0.0.1:54321/functions/v1/api")!
}
```

Create `ios/SettlKit/Sources/SettlKit/APIClient.swift`:

```swift
import Foundation

public struct APIConfig {
    public let baseURL: URL
    public let inviteToken: String
    public let deviceID: String

    public init(baseURL: URL, inviteToken: String, deviceID: String) {
        self.baseURL = baseURL
        self.inviteToken = inviteToken
        self.deviceID = deviceID
    }
}

public enum APIError: Error, Equatable {
    case unauthorized
    case conflict
    case server(Int)
    case decoding
}

public struct APIClient {
    private let config: APIConfig
    private let session: URLSession

    public init(config: APIConfig, session: URLSession = .shared) {
        self.config = config
        self.session = session
    }

    public func members(groupId: String) async throws -> [MemberSummary] {
        let data = try await send("GET", "groups/\(groupId)/members", body: nil)
        return try decode([MemberSummary].self, data)
    }

    public func balances(groupId: String) async throws -> [Transfer] {
        let data = try await send("GET", "groups/\(groupId)/balances", body: nil)
        return try decode(BalancesResponse.self, data).transfers
    }

    public func claim(groupId: String, memberId: String) async throws {
        _ = try await send("POST", "groups/\(groupId)/claim", body: ["memberId": memberId])
    }

    private func send(_ method: String, _ path: String, body: [String: String]?) async throws -> Data {
        var request = URLRequest(url: config.baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue(config.inviteToken, forHTTPHeaderField: "x-settl-token")
        request.setValue(config.deviceID, forHTTPHeaderField: "x-settl-device")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.server(-1) }
        switch http.statusCode {
        case 200 ..< 300: return data
        case 401, 403: throw APIError.unauthorized
        case 409: throw APIError.conflict
        default: throw APIError.server(http.statusCode)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw APIError.decoding }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios/SettlKit && swift test 2>&1 | tail -20 ; cd ../..`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add ios/SettlKit/Sources/SettlKit/Config.swift ios/SettlKit/Sources/SettlKit/APIClient.swift ios/SettlKit/Tests/SettlKitTests/APIClientTests.swift
git commit -m "feat(SettlKit): APIClient (members/balances/claim) + typed errors"
```

---

### Task 7: Extension UI wiring (connect → claim → balances)

**Files:**
- Create: `ios/SettlMessages/ConnectionStore.swift`, `ios/SettlMessages/ConnectView.swift`, `ios/SettlMessages/GroupView.swift`, `ios/SettlMessages/GroupViewModel.swift`
- Modify: `ios/SettlMessages/RootView.swift` (replace the Task 3 placeholder)

This task's automated gate is **compile** (`xcodebuild`); behavior is verified manually (no unit tests for SwiftUI/Messages UI, per the agreed model).

**Interfaces:**
- Consumes: `APIClient`, `APIConfig`, `Config`, `DeviceID`, `MemberSummary`, `Transfer`.

- [ ] **Step 1: Connection model + store**

Create `ios/SettlMessages/ConnectionStore.swift`:

```swift
import Foundation

struct Connection: Codable, Equatable {
    let groupId: String
    let inviteToken: String
}

enum ConnectionStore {
    private static let key = "settl.connection"

    static func load() -> Connection? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Connection.self, from: data)
    }

    static func save(_ connection: Connection) {
        UserDefaults.standard.set(try? JSONEncoder().encode(connection), forKey: key)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}
```

- [ ] **Step 2: View model**

Create `ios/SettlMessages/GroupViewModel.swift`:

```swift
import Foundation
import SettlKit

@MainActor
final class GroupViewModel: ObservableObject {
    @Published var members: [MemberSummary] = []
    @Published var transfers: [Transfer] = []
    @Published var errorMessage: String?
    @Published var loading = false

    private let client: APIClient
    private let groupId: String

    init(connection: Connection) {
        self.groupId = connection.groupId
        let deviceID = DeviceID(store: UserDefaults.standard).current()
        self.client = APIClient(config: APIConfig(
            baseURL: Config.localBaseURL,
            inviteToken: connection.inviteToken,
            deviceID: deviceID,
        ))
    }

    func load() async {
        loading = true
        errorMessage = nil
        do {
            async let m = client.members(groupId: groupId)
            async let t = client.balances(groupId: groupId)
            members = try await m
            transfers = try await t
        } catch let error as APIError {
            errorMessage = message(for: error)
        } catch {
            errorMessage = "Network error. Tap to retry."
        }
        loading = false
    }

    func claim(_ memberId: String) async {
        do {
            try await client.claim(groupId: groupId, memberId: memberId)
            await load()
        } catch let error as APIError {
            errorMessage = message(for: error)
        } catch {
            errorMessage = "Network error. Tap to retry."
        }
    }

    private func message(for error: APIError) -> String {
        switch error {
        case .unauthorized: return "Couldn't connect to this group."
        case .conflict: return "That seat is already claimed."
        case .server, .decoding: return "Something went wrong. Tap to retry."
        }
    }
}
```

- [ ] **Step 3: ConnectView**

Create `ios/SettlMessages/ConnectView.swift`:

```swift
import SwiftUI

struct ConnectView: View {
    let onConnect: (Connection) -> Void
    @State private var groupId = ""
    @State private var inviteToken = ""

    var body: some View {
        VStack(spacing: 12) {
            Text("Connect to a Settl group").font(.headline)
            TextField("Group ID", text: $groupId)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
            TextField("Invite token", text: $inviteToken)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
            Button("Connect") {
                onConnect(Connection(
                    groupId: groupId.trimmingCharacters(in: .whitespaces),
                    inviteToken: inviteToken.trimmingCharacters(in: .whitespaces),
                ))
            }
            .buttonStyle(.borderedProminent)
            .disabled(groupId.isEmpty || inviteToken.isEmpty)
        }
        .padding()
    }
}
```

- [ ] **Step 4: GroupView**

Create `ios/SettlMessages/GroupView.swift`:

```swift
import SwiftUI
import SettlKit

struct GroupView: View {
    @StateObject private var model: GroupViewModel
    let onDisconnect: () -> Void

    init(connection: Connection, onDisconnect: @escaping () -> Void) {
        _model = StateObject(wrappedValue: GroupViewModel(connection: connection))
        self.onDisconnect = onDisconnect
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Group").font(.headline)
                Spacer()
                Button("Disconnect", action: onDisconnect)
            }
            if let error = model.errorMessage {
                Button(error) { Task { await model.load() } }
                    .foregroundStyle(.red)
            }
            if model.loading {
                ProgressView()
            }
            ForEach(model.members) { member in
                HStack {
                    Text(member.displayName)
                    Spacer()
                    if member.claimed {
                        Text("claimed").foregroundStyle(.secondary)
                    } else {
                        Button("I'm \(member.displayName)") {
                            Task { await model.claim(member.id) }
                        }
                    }
                }
            }
            if !model.transfers.isEmpty {
                Divider()
                Text("Balances").font(.subheadline.bold())
                ForEach(model.transfers, id: \.fromMemberId) { t in
                    Text("\(t.fromMemberId) owes \(t.toMemberId): $\(String(format: "%.2f", Double(t.amountCents) / 100))")
                        .font(.caption)
                }
            }
        }
        .padding()
        .task { await model.load() }
    }
}
```

- [ ] **Step 5: Replace RootView**

Replace the contents of `ios/SettlMessages/RootView.swift`:

```swift
import SwiftUI

struct RootView: View {
    @State private var connection: Connection? = ConnectionStore.load()

    var body: some View {
        if let connection {
            GroupView(connection: connection, onDisconnect: {
                ConnectionStore.clear()
                self.connection = nil
            })
        } else {
            ConnectView(onConnect: { connection in
                ConnectionStore.save(connection)
                self.connection = connection
            })
        }
    }
}
```

- [ ] **Step 6: Generate + build to verify it compiles**

Run:
```bash
cd ios && xcodegen generate && \
xcodebuild -project Settl.xcodeproj -scheme Settl \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -15 ; cd ..
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 7: Commit**

```bash
git add ios/SettlMessages
git commit -m "feat: extension UI — connect, claim a seat, show netted balances"
```

- [ ] **Step 8: Manual verification (user)**

This is the part the agentic loop cannot prove. Steps:

1. Ensure local Supabase is running (`supabase start`) and serve the function in a separate terminal:
   `supabase functions serve api --no-verify-jwt`
2. Seed a group with members and print the connection values:
   ```bash
   BASE=http://127.0.0.1:54321/functions/v1/api
   G=$(curl -s -X POST $BASE/groups -H 'content-type: application/json' -d '{"title":"demo"}')
   GID=$(echo "$G" | python3 -c 'import sys,json;print(json.load(sys.stdin)["groupId"])')
   TOK=$(echo "$G" | python3 -c 'import sys,json;print(json.load(sys.stdin)["inviteToken"])')
   curl -s -X POST $BASE/groups/$GID/members -H "x-settl-token: $TOK" -H 'content-type: application/json' -d '{"names":["Charlie","Jake"]}' >/dev/null
   echo "groupId=$GID"; echo "inviteToken=$TOK"
   ```
3. In Xcode (`open ios/Settl.xcodeproj`), run the `SettlMessages` scheme on the iPhone 17 simulator; when prompted pick the Messages app. Open any conversation and tap the Settl app in the drawer.
4. In ConnectView, paste the printed `groupId` and `inviteToken`, tap Connect.
5. Confirm both seats list ("Charlie", "Jake"), tap **"I'm Jake"**, confirm it flips to claimed and balances render without error.

Report whether the round-trip works; any failure here is a finding for the next iteration.

---

## What this slice delivers

A working tracer bullet: an iMessage extension that talks to the Supabase API over HTTP, generates and persists a device id, lists a group's seats, claims one by device, and renders netted balances — with the testable core (`SettlKit`) unit-tested headlessly, the app + extension compile-verified, and the backend extended with prefix-tolerant routing and a read-only members endpoint.

## Explicitly out of scope (later slices)

- In-app group creation and the `MSMessage` card bubble + token discovery — Slice 2.
- Create flows (split/order/loan/pool), settle, Venmo deep-link, manual mark — Slices 2–4.
- Chase / drafted reminders — Slice 5.
- Real-device (non-simulator) use, which needs the edge function deployed + a reachable base URL.
