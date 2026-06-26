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
