import Foundation

/// What the shells and the server agree on: the server's exit code for a restart, the line it announces its address
/// with, the environment it is started with, and the bridge between the web UI and the shell (messages, ShellInfo).
/// The desktop app keeps the same values in apps/desktop/src/shell-contract.ts; the server's side is in
/// apps/server/src (server.ts, config.ts, core/backup-routes.ts), the web UI's in apps/web/src/lib/native.ts.
/// apps/desktop/test/shell-contract.test.ts checks that all of them still match (it reads this file).
enum ShellContract {
    /// Exit code of the server when it restarts itself on purpose (e.g. to apply a restored backup).
    static let restartExitCode: Int32 = 75

    /// Start of the line the server writes to stdout once it listens: `CADENCE_LISTENING {"url":"…","port":28787}`.
    static let listeningPrefix = "CADENCE_LISTENING "

    /// The port from the server's listening line in `output`; nil until the whole line is there.
    static func listeningPort(in output: String) -> Int? {
        guard let range = output.range(of: listeningPrefix) else { return nil }
        let rest = output[range.upperBound...]
        guard let nl = rest.firstIndex(where: \.isNewline), // also "\r\n", one Character in Swift
              let json = String(rest[..<nl]).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              obj["url"] is String,
              let port = obj["port"] as? Int else { return nil }
        return port
    }

    /// The environment the built-in server is started with, on top of the app's own (apps/server/src/config.ts).
    static func serverEnvironment(port: Int, dataDirectory: URL, webDirectory: URL, parentPid: Int32) -> [String: String] {
        [
            "CADENCE_MODE": "desktop",
            "PORT": String(port),
            "HOST": "127.0.0.1",
            "CADENCE_DATA_DIR": dataDirectory.path,
            "CADENCE_WEB_DIR": webDirectory.path,
            "CADENCE_PARENT_PID": String(parentPid),
            "NODE_ENV": "production",
        ]
    }

    /// The messages the web UI posts through the bridge as `{ type, … }` (postNative in apps/web/src/lib/native.ts).
    enum Message: String, CaseIterable {
        case pickImportFile, openDataFolder, saveFile, connectServer
    }

    /// What the app tells the web UI about itself (`window.cadenceShell`, for Settings → Server).
    static func shellInfo(version: String, remote: URL?) -> [String: Any] {
        ["app": "macos", "version": version, "remote": remote?.absoluteString ?? NSNull()]
    }
}
