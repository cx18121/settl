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
