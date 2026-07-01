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
