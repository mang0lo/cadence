// swift-tools-version:5.10
import PackageDescription

// Native macOS shell for Cadence: starts the bundled Node server and shows the web UI in a WKWebView.
// Build the full .app with `npm run mac` (scripts/build-macos.sh); `swift build` alone builds the executable.
let package = Package(
    name: "Cadence",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Cadence",
            path: "Sources/Cadence"
        ),
    ]
)
