import AppKit
import UniformTypeIdentifiers
import WebKit

/// Avoids the retain cycle WKUserContentController → handler → web view.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}

/// Native overlay shown while the server starts or when it failed.
final class StatusOverlay: NSView {
    private let spinner = NSProgressIndicator()
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let buttons = NSStackView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let logo = NSImageView(image: NSApp.applicationIconImage ?? NSImage())
        logo.translatesAutoresizingMaskIntoConstraints = false
        logo.widthAnchor.constraint(equalToConstant: 72).isActive = true
        logo.heightAnchor.constraint(equalToConstant: 72).isActive = true

        spinner.style = .spinning
        spinner.controlSize = .small
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.alignment = .center
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .center
        detail.preferredMaxLayoutWidth = 420
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let stack = NSStackView(views: [logo, title, spinner, detail, buttons])
        stack.orientation = .vertical
        stack.spacing = 12
        stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func show(title: String, detail: String = "", spinning: Bool, actions: [(String, () -> Void)] = []) {
        self.title.stringValue = title
        self.detail.stringValue = detail
        self.detail.isHidden = detail.isEmpty
        spinner.isHidden = !spinning
        spinning ? spinner.startAnimation(nil) : spinner.stopAnimation(nil)
        buttons.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (label, action) in actions {
            let b = ClosureButton(title: label, action: action)
            buttons.addArrangedSubview(b)
        }
        buttons.isHidden = actions.isEmpty
        isHidden = false
    }

    func hide() {
        spinner.stopAnimation(nil)
        isHidden = true
    }
}

private final class ClosureButton: NSButton {
    private var handler: (() -> Void)?
    convenience init(title: String, action: @escaping () -> Void) {
        self.init(frame: .zero)
        self.title = title
        bezelStyle = .rounded
        handler = action
        target = self
        self.action = #selector(fire)
    }
    @objc private func fire() { handler?() }
}

final class WebViewController: NSViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private(set) var webView: WKWebView!
    private let overlay = StatusOverlay()
    private(set) var baseURL: URL?
    /// The origins of the server's pages (ShellPolicy): baseURL's, and where the server sent the app's own load.
    private var appOrigins: [ShellPolicy.Origin] = []
    /// The app's own load of baseURL, to learn where a server redirect took it.
    private var appLoad: WKNavigation?
    /// Called by the web UI through the bridge or by menu items; implemented by the app delegate.
    var onRestartRequested: (() -> Void)?
    /// Settings → Server in the web UI: use this server from now on (nil = the one built into the app).
    var onConnectServer: ((URL?) -> Void)?
    /// A page did not load (network error).
    var onLoadFailed: ((Error) -> Void)?

    /// Shown to the web UI as `window.cadenceShell` (app version, the server in use) before its scripts run.
    var shellInfo: [String: Any] = [:] {
        didSet { installShellInfo() }
    }

    private func installShellInfo() {
        guard isViewLoaded,
              let data = try? JSONSerialization.data(withJSONObject: shellInfo),
              let json = String(data: data, encoding: .utf8) else { return }
        let scripts = webView.configuration.userContentController
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(source: "window.cadenceShell = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(WeakScriptHandler(self), name: "cadence")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.websiteDataStore = .default()

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.setValue(false, forKey: "drawsBackground")
        webView.translatesAutoresizingMaskIntoConstraints = false
        overlay.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView()
        root.addSubview(webView)
        root.addSubview(overlay)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            webView.topAnchor.constraint(equalTo: root.topAnchor),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: root.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        view = root
    }

    // MARK: - States

    func showStarting() {
        overlay.show(title: "Starting Cadence…", spinning: true)
    }

    func showError(_ error: Error) {
        overlay.show(
            title: "Cadence could not start",
            detail: error.localizedDescription,
            spinning: false,
            actions: [
                ("Try Again", { [weak self] in self?.onRestartRequested?() }),
                ("Show Log", { NSWorkspace.shared.open(ServerProcess.logFile) }),
            ]
        )
    }

    func load(_ url: URL) {
        baseURL = url
        appOrigins = ShellPolicy.Origin(url).map { [$0] } ?? []
        pageLoaded = false
        overlay.hide()
        let first = pendingPath.flatMap { URL(string: $0, relativeTo: url) } ?? url
        pendingPath = nil
        appLoad = webView.load(URLRequest(url: first))
    }

    /// Until the built-in server kept its port, every launch gave the page a new origin (http://127.0.0.1:<port>)
    /// and left what it had stored under the old one behind for good. Removes all of it once, before the page first
    /// loads on its lasting port (WebKit keeps one record per host, for all ports).
    func removeLocalWebsiteData(then done: @escaping () -> Void) {
        let store = webView.configuration.websiteDataStore
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        store.fetchDataRecords(ofTypes: types) { records in
            let local = records.filter { $0.displayName == "127.0.0.1" }
            if local.isEmpty { done() } else { store.removeData(ofTypes: types, for: local, completionHandler: done) }
        }
    }

    /// A remote server that does not answer: try again or go back to the built-in server.
    func showServerUnreachable(_ url: URL, _ error: Error) {
        overlay.show(
            title: "\(url.host ?? url.absoluteString) is not reachable",
            detail: error.localizedDescription,
            spinning: false,
            actions: [
                ("Try Again", { [weak self] in self?.onRestartRequested?() }),
                ("Use Built-in Server", { [weak self] in self?.onConnectServer?(nil) }),
            ]
        )
    }

    /// A page asked for before the first load (e.g. an export dropped on the Dock icon launched the app): shown first.
    private var pendingPath: String?

    func navigate(to path: String) {
        guard let base = baseURL else {
            pendingPath = path
            return
        }
        guard let url = URL(string: path, relativeTo: base) else { return }
        webView.load(URLRequest(url: url))
    }

    func evaluate(_ js: String) {
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Native import panel

    func pickImportFile() {
        guard let window = view.window else { return }
        let panel = NSOpenPanel()
        panel.message = "Choose your Apple Health export (export.zip, export.xml or the unzipped folder) or FIT files (a .fit file, or a zip or folder of them)"
        panel.prompt = "Import"
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = ImportFiles.contentTypes
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.startLocalImport(path: url.path)
        }
    }

    private var pendingImport: String?
    private var pageLoaded = false

    /// Hands a local path to the web UI (no upload copy needed for multi-GB exports).
    /// Called from the open panel and when an export is dropped on the Dock icon / opened with Cadence.
    func startLocalImport(path: String) {
        guard pageLoaded else {
            pendingImport = path
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: [path]),
              let arr = String(data: data, encoding: .utf8) else { return }
        evaluate("""
        (function (p) {
          if (location.pathname === '/import') {
            window.dispatchEvent(new CustomEvent('cadence:native-import', { detail: { path: p } }));
          } else {
            location.assign('/import?nativePath=' + encodeURIComponent(p));
          }
        })(\(arr)[0]);
        """)
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        // only the app's own page reaches the bridge, not another site that ended up in the window (ShellPolicy)
        let frame = message.frameInfo
        let origin = ShellPolicy.Origin(scheme: frame.securityOrigin.protocol, host: frame.securityOrigin.host,
                                        port: frame.securityOrigin.port)
        guard ShellPolicy.acceptsMessage(isMainFrame: frame.isMainFrame, from: origin, appOrigins: appOrigins) else { return }
        guard let body = message.body as? [String: Any], let type = body["type"] as? String,
              let kind = ShellContract.Message(rawValue: type) else { return }
        switch kind {
        case .pickImportFile: pickImportFile() // the panel picks files and folders: `folder` needs no answer here
        case .openDataFolder: NSWorkspace.shared.open(ServerProcess.dataDirectory)
        case .saveFile: saveFile(body)
        case .connectServer: connectServer(body)
        }
    }

    /// `{ url }` from Settings → Server; an empty url switches back to the built-in server.
    private func connectServer(_ body: [String: Any]) {
        let text = ((body["url"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            onConnectServer?(nil)
        } else if let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil {
            confirmServer(url) { [weak self] ok in
                if ok { self?.onConnectServer?(url) } else { self?.webView.reload() } // the page waits for the switch
            }
        } else {
            NSSound.beep()
        }
    }

    /// Showing another server from now on is confirmed here, in a sheet no page can draw, so a page cannot switch the
    /// app to a server of its choosing. Going back to the built-in server needs no confirmation.
    private func confirmServer(_ url: URL, then done: @escaping (Bool) -> Void) {
        guard let window = view.window else { return done(false) }
        let host = url.host.map { h in url.port.map { "\(h):\($0)" } ?? h } ?? url.absoluteString
        let alert = NSAlert()
        alert.messageText = "Show the Cadence server at \(host)?"
        alert.informativeText = "From now on, Cadence shows \(url.absoluteString) instead of the server built into this app."
            + (url.scheme?.lowercased() == "http" ? " The connection to it is not encrypted (http): use it only on a network you trust." : "")
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { done($0 == .alertFirstButtonReturn) }
    }

    /// A file the web UI created itself (share images): blob downloads are unreliable in WKWebView, so the page
    /// posts `{ filename, base64 }` and the image is written to ~/Downloads. Only PNG images are accepted.
    private func saveFile(_ body: [String: Any]) {
        guard let name = body["filename"] as? String,
              let base64 = body["base64"] as? String,
              let data = Data(base64Encoded: base64) else { return }
        var filename = (name as NSString).lastPathComponent
        if filename.hasPrefix(".") || (filename as NSString).pathExtension.lowercased() != "png" {
            filename = "cadence.png"
        }
        let target = uniqueDownloadURL(for: filename)
        do {
            try data.write(to: target, options: .atomic)
            NSSound(named: "Glass")?.play()
            NSWorkspace.shared.activateFileViewerSelecting([target])
        } catch {
            NSSound.beep()
        }
    }

    /// ~/Downloads/<name>, or "<name> 2", "<name> 3" … when that file exists.
    private func uniqueDownloadURL(for filename: String) -> URL {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var target = downloads.appendingPathComponent(filename)
        let base = target.deletingPathExtension().lastPathComponent
        let ext = target.pathExtension
        var n = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = downloads.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        return target
    }

    // MARK: - WKUIDelegate

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        if let window = view.window {
            panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
        } else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }

    /// target=_blank / window.open → default browser (http, https and mailto only: ShellPolicy).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ShellPolicy.isExternal(url) { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        // Links to other sites open in the default browser (ShellPolicy). New windows (no target frame) go to
        // createWebViewWith; frames inside the page load as they are (they never reach the bridge).
        guard navigationAction.targetFrame?.isMainFrame == true, let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let userAction = navigationAction.navigationType == .linkActivated || navigationAction.navigationType == .formSubmitted
        switch ShellPolicy.navigation(to: url, userAction: userAction, appOrigins: appOrigins) {
        case .allow:
            decisionHandler(.allow)
        case .openExternally:
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        case .cancel:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
           disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
            return
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// The page could not be loaded at all (e.g. a remote server that is offline).
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        onLoadFailed?(error)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // the server may have sent the app elsewhere (e.g. from http to https): the page there is the app as well
        guard navigation != nil, navigation === appLoad, let landed = ShellPolicy.Origin(webView.url),
              !appOrigins.contains(landed) else { return }
        appOrigins.append(landed)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        if let path = pendingImport {
            pendingImport = nil
            startLocalImport(path: path)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: - WKDownloadDelegate (GPX / data exports → ~/Downloads)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        completionHandler(uniqueDownloadURL(for: suggestedFilename))
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }
}
