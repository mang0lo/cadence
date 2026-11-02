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

    /// Development: load a running Vite dev server instead (e.g. CADENCE_DEV_URL=http://localhost:5173).
    static var devURL: URL? {
        guard let s = ProcessInfo.processInfo.environment["CADENCE_DEV_URL"], !s.isEmpty else { return nil }
        return URL(string: s)
    }
}
