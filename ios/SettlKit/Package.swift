// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SettlKit",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "SettlKit", targets: ["SettlKit"])],
    targets: [
        .target(name: "SettlKit"),
        .testTarget(name: "SettlKitTests", dependencies: ["SettlKit"]),
    ]
)
