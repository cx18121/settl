import SwiftUI

struct RootView: View {
    @State private var connection: Connection? = ConnectionStore.load()

    var body: some View {
        if let connection {
            GroupView(connection: connection, onDisconnect: {
                ConnectionStore.clear()
                self.connection = nil
            })
        } else {
            ConnectView(onConnect: { connection in
                ConnectionStore.save(connection)
                self.connection = connection
            })
        }
    }
}
