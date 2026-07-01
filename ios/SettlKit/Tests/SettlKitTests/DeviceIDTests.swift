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
