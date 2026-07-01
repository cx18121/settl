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
