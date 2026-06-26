import XCTest
@testable import SettlKit

final class PlaceholderTests: XCTestCase {
    func testNameIsSet() {
        XCTAssertEqual(SettlKit.name, "SettlKit")
    }
}
