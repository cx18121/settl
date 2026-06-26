import SwiftUI
import SettlKit

struct GroupView: View {
    @StateObject private var model: GroupViewModel
    let onDisconnect: () -> Void

    init(connection: Connection, onDisconnect: @escaping () -> Void) {
        _model = StateObject(wrappedValue: GroupViewModel(connection: connection))
        self.onDisconnect = onDisconnect
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Group").font(.headline)
                Spacer()
                Button("Disconnect", action: onDisconnect)
            }
            if let error = model.errorMessage {
                Button(error) { Task { await model.load() } }
                    .foregroundStyle(.red)
            }
            if model.loading {
                ProgressView()
            }
            ForEach(model.members) { member in
                HStack {
                    Text(member.displayName)
                    Spacer()
                    if member.claimed {
                        Text("claimed").foregroundStyle(.secondary)
                    } else {
                        Button("I'm \(member.displayName)") {
                            Task { await model.claim(member.id) }
                        }
                    }
                }
            }
            if !model.transfers.isEmpty {
                Divider()
                Text("Balances").font(.subheadline.bold())
                ForEach(model.transfers, id: \.fromMemberId) { t in
                    Text("\(t.fromMemberId) owes \(t.toMemberId): $\(String(format: "%.2f", Double(t.amountCents) / 100))")
                        .font(.caption)
                }
            }
        }
        .padding()
        .task { await model.load() }
    }
}
