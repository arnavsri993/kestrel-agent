// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "KestrelMobile",
    defaultLocalization: "en",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "KestrelMobile",
            targets: ["KestrelMobile"]
        )
    ],
    dependencies: [],
    targets: [
        .target(
            name: "KestrelMobile",
            dependencies: [],
            path: "KestrelBrowser/Sources",
            resources: [
                .process("../Resources")
            ]
        ),
        .testTarget(
            name: "KestrelMobileTests",
            dependencies: ["KestrelMobile"],
            path: "KestrelBrowser/Tests"
        )
    ]
)
