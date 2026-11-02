import AppKit

// Entry point. AppKit (not SwiftUI) because the app is a single WKWebView window with a native
// menu bar, open panels and a child server process.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) {
        app.run()
    }
}
