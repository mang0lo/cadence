import Foundation

/// What the shells and the server agree on: the server's exit code for a restart, the line it announces its address
/// with, the environment it is started with, and the bridge between the web UI and the shell (messages, events,
/// ShellInfo). This is the Mac app's copy of packages/shared/src/shell.ts, which the server, the web UI and the
/// desktop app (apps/desktop/src/shell-contract.ts) import; change both together.
/// apps/desktop/test/shell-contract.test.ts checks that they still match (it reads this file).
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
        case pickImportFile, importReady, openDataFolder, saveFile, connectServer
    }

    /// The file types (extensions) the app saves for the page (`saveFile`): images it drew and data exports. They keep
    /// the name the page gave; anything else (apps, scripts, web pages …) is refused.
    static let savedFileTypes: Set<String> = ["png", "jpg", "jpeg", "csv", "gpx", "tcx", "json", "txt"]

    /// The name a file the page made (`saveFile`) is saved under: the name it gave without folders, characters
    /// Windows does not allow replaced (as the desktop app does), "cadence.<type>" for a name that would hide the
    /// file; nil when its type is none of savedFileTypes.
    static func savedFileName(_ name: String) -> String? {
        // what follows the last separator, "" after a trailing one (like the desktop app's split)
        let last = name.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        let unsafe = Set("<>:\"|?*".unicodeScalars)
        let scalars = last.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7F || unsafe.contains($0) ? "_" : $0 }
        let base = String(String.UnicodeScalarView(scalars)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let dot = base.lastIndex(of: ".") else { return nil }
        let type = base[base.index(after: dot)...].lowercased()
        guard savedFileTypes.contains(type) else { return nil }
        let stem = base[..<dot]
        return stem.isEmpty || stem.hasPrefix(".") ? "cadence.\(type)" : base
    }

    /// The window event that hands the import page a path to import (`detail: { path, confirm? }`). The import page
    /// cancels it when it takes the path.
    static let importEvent = "cadence:native-import"

    /// Body for `callAsyncJavaScript` with the arguments `path` and `event` (importEvent): hands the open import page
    /// a path picked in the app, which it imports at once, and returns true. When no import page listens, it opens
    /// the import page, which asks for the path once it listens (`importReady`), and returns false.
    static let offerImportScript = """
        if (!window.dispatchEvent(new CustomEvent(event, { detail: { path }, cancelable: true }))) return true;
        location.assign('/import');
        return false;
        """

    /// Body for `callAsyncJavaScript` with `path` and `event`: the answer to `importReady`. The import page shows the
    /// path and asks before it imports it (picked while another page was open, or dropped on the Dock icon).
    static let handOverImportScript = """
        window.dispatchEvent(new CustomEvent(event, { detail: { path, confirm: true }, cancelable: true }));
        """

    /// The window event that tells the page the user cancelled what a message asked for (`detail: { type }`).
    static let cancelledEvent = "cadence:native-cancelled"

    /// Body for `callAsyncJavaScript` with `type` (a Message) and `event` (cancelledEvent): the page that waits for the
    /// answer takes the event; any other page is reloaded, as the app did before the event existed.
    static let cancelledScript = """
        if (window.dispatchEvent(new CustomEvent(event, { detail: { type }, cancelable: true }))) location.reload();
        """

    /// What the app tells the web UI about itself (`window.cadenceShell`, for Settings → Server).
    static func shellInfo(version: String, remote: URL?) -> [String: Any] {
        ["app": "macos", "version": version, "remote": remote?.absoluteString ?? NSNull()]
    }
}
