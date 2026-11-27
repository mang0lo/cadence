import Foundation

/// What the Mac app lets the pages in its window do. The desktop app (Electron) follows the same rules
/// (apps/desktop/src/policy.ts):
///
///  - The app's pages are those of the Cadence server it shows: the origin (scheme, host, port) of that server, and
///    the origin the server sent the app's own load to (e.g. a redirect from http to https).
///  - Only the main frame of an app page reaches the native bridge (import panel, saving files, Settings → Server)
///    and saves downloads into ~/Downloads (links with `download`, attachments, files the window cannot show).
///  - Links and form submissions to other sites open in the default browser instead of the window. Other
///    navigations (server redirects, scripts) may still bring another site into the window, but its pages never
///    reach the bridge.
///  - Only http(s) and mailto URLs are handed to the operating system; file:, smb:, vnc:, custom app schemes and the
///    like never are.
///
/// No AppKit or WebKit here: the rules are tested on their own (apps/macos/Tests/CadenceTests).
enum ShellPolicy {
    /// Scheme, host and port of a web page, with the default port filled in ("http", "127.0.0.1", 28787).
    struct Origin: Hashable, CustomStringConvertible {
        let scheme: String
        let host: String
        let port: Int

        /// `port` 0 or nil means the scheme's default port (WKSecurityOrigin reports default ports as 0).
        init?(scheme: String?, host: String?, port: Int?) {
            guard let scheme = scheme?.lowercased(), scheme == "http" || scheme == "https",
                  var host = host?.lowercased(), !host.isEmpty else { return nil }
            if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
            self.scheme = scheme
            self.host = host
            self.port = port.flatMap { $0 == 0 ? nil : $0 } ?? (scheme == "https" ? 443 : 80)
        }

        init?(_ url: URL?) {
            guard let url else { return nil }
            self.init(scheme: url.scheme, host: url.host, port: url.port)
        }

        var description: String { "\(scheme)://\(host):\(port)" }
    }

    enum Navigation: Equatable {
        /// Load it in the window.
        case allow
        /// Hand it to the default browser (or mail app) and keep the window where it is.
        case openExternally
        /// Neither.
        case cancel
    }

    /// URLs the operating system may open (default browser, mail app).
    static func isExternal(_ url: URL) -> Bool {
        ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "")
    }

    /// A navigation of the window's main frame. `userAction`: a link click or form submission (not a redirect, a
    /// script, a reload or the app's own load).
    static func navigation(to url: URL, userAction: Bool, appOrigins: [Origin]) -> Navigation {
        if let origin = Origin(url) {
            if appOrigins.contains(origin) { return .allow }
            return userAction ? .openExternally : .allow
        }
        switch url.scheme?.lowercased() ?? "" {
        case "mailto": return userAction ? .openExternally : .cancel
        case "about", "blob", "data": return .allow // WebKit's own rules apply
        default: return .cancel // file:, smb:, vnc:, custom app schemes …
        }
    }

    /// A bridge message: only from the main frame of an app page.
    static func acceptsMessage(isMainFrame: Bool, from origin: Origin?, appOrigins: [Origin]) -> Bool {
        guard isMainFrame, let origin else { return false }
        return appOrigins.contains(origin)
    }

    /// A download into ~/Downloads: like the bridge, only for the main frame of an app page. Frames inside the page
    /// and pages of other sites in the window (e.g. brought there by a redirect) save nothing.
    static func allowsDownload(isMainFrame: Bool, from origin: Origin?, appOrigins: [Origin]) -> Bool {
        acceptsMessage(isMainFrame: isMainFrame, from: origin, appOrigins: appOrigins)
    }

    /// Where a download the main frame received comes from: its URL's origin, or for a blob: URL the origin of the page
    /// that made it, which the URL names (`blob:http://127.0.0.1:28787/<uuid>`). The window's own URL cannot tell:
    /// while the download loads, it already is the download's URL. data: URLs have no origin (and WebKit does not
    /// navigate the window to them; the app's pages save them through links with `download`).
    static func downloadOrigin(of url: URL?) -> Origin? {
        guard let url else { return nil }
        if let origin = Origin(url) { return origin }
        guard url.scheme?.lowercased() == "blob" else { return nil }
        return Origin(URL(string: String(url.absoluteString.dropFirst("blob:".count))))
    }
}
