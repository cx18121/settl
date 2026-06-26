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
