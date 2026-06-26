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
                let trimmedGroupId = groupId.trimmingCharacters(in: .whitespaces)
                let trimmedInviteToken = inviteToken.trimmingCharacters(in: .whitespaces)
                onConnect(Connection(groupId: trimmedGroupId, inviteToken: trimmedInviteToken))
            }
            .buttonStyle(.borderedProminent)
            .disabled(groupId.trimmingCharacters(in: .whitespaces).isEmpty || inviteToken.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding()
    }
}
