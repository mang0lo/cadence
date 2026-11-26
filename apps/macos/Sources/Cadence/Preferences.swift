import Foundation

/// Native preferences (UserDefaults). Everything else is configured inside the web UI.
enum Preferences {
    /// A smoke run (SmokeTest) neither reads nor writes the user's preferences: it keeps its own in memory.
    private static var memory: [String: Any]? = SmokeTest.isActive ? [:] : nil

    private static func value(_ key: String) -> Any? {
        memory.map { $0[key] } ?? UserDefaults.standard.object(forKey: key)
    }

    private static func set(_ value: Any?, _ key: String) {
        if memory != nil { memory![key] = value } else { UserDefaults.standard.set(value, forKey: key) }
    }

    private static let remoteKey = "remoteServerURL"

    /// When set, the app shows a remote Cadence server instead of starting the bundled one.
    static var remoteServerURL: URL? {
        get {
            guard let s = value(remoteKey) as? String, !s.isEmpty else { return nil }
            return URL(string: s)
        }
        set {
            set(newValue?.absoluteString, remoteKey)
        }
    }

    private static let portKey = "serverPort"

    /// The port the built-in server listened on last time (nil before its first start). Starting on the same port
    /// again keeps the web UI's origin, and with it everything the page keeps in the browser (cached settings,
    /// remembered choices, map thumbnails).
    static var serverPort: Int? {
        get {
            let raw = value(portKey) // a number, or text when set with `defaults write` without -int
            let port = (raw as? Int) ?? (raw as? String).flatMap { Int($0) } ?? 0
            return (1...65535).contains(port) ? port : nil
        }
        set {
            set(newValue, portKey)
        }
    }

    /// Development: load a running Vite dev server instead (e.g. CADENCE_DEV_URL=http://localhost:5173).
    static var devURL: URL? {
        guard let s = ProcessInfo.processInfo.environment["CADENCE_DEV_URL"], !s.isEmpty else { return nil }
        return URL(string: s)
    }
}
