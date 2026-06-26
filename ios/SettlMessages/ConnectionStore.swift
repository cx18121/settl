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
