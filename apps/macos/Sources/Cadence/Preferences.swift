import Foundation

/// Native preferences (UserDefaults). Everything else is configured inside the web UI.
enum Preferences {
    private static let remoteKey = "remoteServerURL"

    /// When set, the app shows a remote Cadence server instead of starting the bundled one.
    static var remoteServerURL: URL? {
        get {
            guard let s = UserDefaults.standard.string(forKey: remoteKey), !s.isEmpty else { return nil }
            return URL(string: s)
        }
        set {
            UserDefaults.standard.set(newValue?.absoluteString, forKey: remoteKey)
        }
    }

    private static let portKey = "serverPort"

    /// The port the built-in server listened on last time (nil before its first start). Starting on the same port
    /// again keeps the web UI's origin, and with it everything the page keeps in the browser (cached settings,
    /// remembered choices, map thumbnails).
    static var serverPort: Int? {
        get {
            let port = UserDefaults.standard.integer(forKey: portKey)
            return (1...65535).contains(port) ? port : nil
        }
        set {
            UserDefaults.standard.set(newValue, forKey: portKey)
        }
    }

    /// Development: load a running Vite dev server instead (e.g. CADENCE_DEV_URL=http://localhost:5173).
    static var devURL: URL? {
        guard let s = ProcessInfo.processInfo.environment["CADENCE_DEV_URL"], !s.isEmpty else { return nil }
        return URL(string: s)
    }
}
