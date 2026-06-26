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
                onConnect(Connection(
                    groupId: groupId.trimmingCharacters(in: .whitespaces),
                    inviteToken: inviteToken.trimmingCharacters(in: .whitespaces),
                ))
            }
            .buttonStyle(.borderedProminent)
            .disabled(groupId.isEmpty || inviteToken.isEmpty)
        }
        .padding()
    }
}
