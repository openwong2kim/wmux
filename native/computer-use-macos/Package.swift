// swift-tools-version: 5.9
// The release runner (macos-14) ships Xcode 15.x, so this package stays on
// tools 5.9 / Swift 5 mode. The deployment target is the floor the helper
// needs: SCScreenshotManager and ignoreShadowsSingleWindow are macOS 14.

import PackageDescription

let package = Package(
    name: "computer-use-macos",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "wmux-computer-use", targets: ["wmux-computer-use"]),
    ],
    targets: [
        // Pure logic (tree rendering, key mapping, scale math): no AX, no
        // CGEvent, so it is unit-testable without any TCC grant.
        .target(name: "ComputerUseCore"),
        .executableTarget(
            name: "wmux-computer-use",
            dependencies: ["ComputerUseCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Carbon"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        ),
        .testTarget(name: "ComputerUseCoreTests", dependencies: ["ComputerUseCore"]),
    ]
)
