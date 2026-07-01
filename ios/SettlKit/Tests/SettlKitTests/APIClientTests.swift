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
        } catch {
            XCTFail("expected APIError")
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
        } catch {
            XCTFail("expected APIError")
        }
    }
}
