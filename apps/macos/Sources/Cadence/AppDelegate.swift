import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private let web = WebViewController()
    private let server = ServerProcess()
    /// CFBundleShortVersionString (set from package.json by scripts/build-macos.sh); nil in `swift run` builds.
    private let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMenu()

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1380, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        // the version in the title bar, next to the window buttons
        window.title = version.map { "Cadence \($0)" } ?? "Cadence"
        window.minSize = NSSize(width: 820, height: 560)
        window.contentViewController = web
        window.delegate = self
        window.tabbingMode = .disallowed
        if !window.setFrameUsingName("CadenceMain") { window.center() }
        window.setFrameAutosaveName("CadenceMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        web.onRestartRequested = { [weak self] in self?.startBackend() }
        web.onConnectServer = { [weak self] url in
            Preferences.remoteServerURL = url
            self?.startBackend()
        }
        web.onLoadFailed = { [weak self] error in
            // only a remote server can be unreachable; the built-in one reports through the server process
            guard let remote = Preferences.remoteServerURL else { return }
            self?.web.showServerUnreachable(remote, error)
        }
        server.onUnexpectedExit = { [weak self] code in
            // 75 = the server restarts itself on purpose (e.g. to apply a restored backup)
            if code == 75 {
                self?.startBackend()
            } else {
                self?.web.showError(ServerError.exited(code))
            }
        }
        startBackend()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// export.zip dropped on the Dock icon or opened with Cadence → import it.
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first(where: { ["zip", "xml"].contains($0.pathExtension.lowercased()) || $0.hasDirectoryPath }) else { return }
        web.startLocalImport(path: url.path)
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }

    /// Remote server (Preferences) → dev server (CADENCE_DEV_URL) → bundled local server.
    private func startBackend() {
        server.stop()
        web.shellInfo = [
            "app": "macos",
            "version": version ?? "dev",
            "remote": Preferences.remoteServerURL?.absoluteString ?? NSNull(),
        ]
        if let remote = Preferences.remoteServerURL {
            window.subtitle = remote.host ?? ""
            web.load(remote)
            return
        }
        window.subtitle = ""
        if let dev = Preferences.devURL {
            web.load(dev)
            return
        }
        web.showStarting()
        let firstOnLastingPort = Preferences.serverPort == nil
        server.start { [weak self] result in
            switch result {
            case .success(let url):
                if firstOnLastingPort {
                    self?.web.removeLocalWebsiteData { self?.web.load(url) }
                } else {
                    self?.web.load(url)
                }
            case .failure(let error): self?.web.showError(error)
            }
        }
    }

    // MARK: - Menu actions

    @objc private func importExport(_ sender: Any?) {
        // a remote server cannot read files on this Mac: its import page uploads the file instead
        if Preferences.remoteServerURL != nil { web.navigate(to: "/import") } else { web.pickImportFile() }
    }
    @objc private func openSettings(_ sender: Any?) { web.navigate(to: "/settings") }
    @objc private func openDataFolder(_ sender: Any?) {
        try? FileManager.default.createDirectory(at: ServerProcess.dataDirectory, withIntermediateDirectories: true)
        NSWorkspace.shared.open(ServerProcess.dataDirectory)
    }
    @objc private func showServerLog(_ sender: Any?) { NSWorkspace.shared.open(ServerProcess.logFile) }
    @objc private func openInBrowser(_ sender: Any?) {
        if let url = web.webView.url ?? web.baseURL { NSWorkspace.shared.open(url) }
    }
    @objc private func reload(_ sender: Any?) { web.webView.reload() }
    @objc private func goBack(_ sender: Any?) { web.webView.goBack() }
    @objc private func goForward(_ sender: Any?) { web.webView.goForward() }
    @objc private func zoomIn(_ sender: Any?) { web.webView.pageZoom = min(2, web.webView.pageZoom + 0.1) }
    @objc private func zoomOut(_ sender: Any?) { web.webView.pageZoom = max(0.5, web.webView.pageZoom - 0.1) }
    @objc private func zoomReset(_ sender: Any?) { web.webView.pageZoom = 1 }
    @objc private func openGitHub(_ sender: Any?) {
        NSWorkspace.shared.open(URL(string: "https://github.com/mang0lo/cadence")!)
    }

    @objc private func connectToServer(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Connect to a Cadence server"
        alert.informativeText = "Enter the address of a Cadence server (for example http://homeserver.local:8787). Leave it empty to use the server built into this app."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "http://homeserver.local:8787"
        field.stringValue = Preferences.remoteServerURL?.absoluteString ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            Preferences.remoteServerURL = nil
        } else if let url = URL(string: text.contains("://") ? text : "http://\(text)"), url.host != nil {
            Preferences.remoteServerURL = url
        } else {
            NSSound.beep()
            return
        }
        startBackend()
    }

    // MARK: - Menu

    private func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        if let action, responds(to: action) { i.target = self }
        return i
    }

    private func buildMenu() -> NSMenu {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(item("About Cadence", #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Settings…", #selector(openSettings(_:)), ","))
        appMenu.addItem(item("Connect to Server…", #selector(connectToServer(_:))))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Hide Cadence", #selector(NSApplication.hide(_:)), "h"))
        appMenu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        appMenu.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:))))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Quit Cadence", #selector(NSApplication.terminate(_:)), "q"))
        add(appMenu, title: "Cadence", to: main)

        let file = NSMenu(title: "File")
        file.addItem(item("Import Apple Health Export…", #selector(importExport(_:)), "i"))
        file.addItem(.separator())
        file.addItem(item("Open Data Folder", #selector(openDataFolder(_:))))
        file.addItem(item("Show Server Log", #selector(showServerLog(_:))))
        file.addItem(item("Open in Browser", #selector(openInBrowser(_:)), "o", [.command, .shift]))
        file.addItem(.separator())
        file.addItem(item("Close Window", #selector(NSWindow.performClose(_:)), "w"))
        add(file, title: "File", to: main)

        let edit = NSMenu(title: "Edit")
        edit.addItem(item("Undo", Selector(("undo:")), "z"))
        edit.addItem(item("Redo", Selector(("redo:")), "z", [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        edit.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        edit.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        edit.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))
        add(edit, title: "Edit", to: main)

        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(item("Reload", #selector(reload(_:)), "r"))
        viewMenu.addItem(item("Back", #selector(goBack(_:)), "["))
        viewMenu.addItem(item("Forward", #selector(goForward(_:)), "]"))
        viewMenu.addItem(.separator())
        viewMenu.addItem(item("Actual Size", #selector(zoomReset(_:)), "0"))
        viewMenu.addItem(item("Zoom In", #selector(zoomIn(_:)), "+"))
        viewMenu.addItem(item("Zoom Out", #selector(zoomOut(_:)), "-"))
        viewMenu.addItem(.separator())
        viewMenu.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        add(viewMenu, title: "View", to: main)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        windowMenu.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        add(windowMenu, title: "Window", to: main)
        NSApp.windowsMenu = windowMenu

        let help = NSMenu(title: "Help")
        help.addItem(item("Cadence on GitHub", #selector(openGitHub(_:))))
        add(help, title: "Help", to: main)
        NSApp.helpMenu = help

        return main
    }

    private func add(_ submenu: NSMenu, title: String, to main: NSMenu) {
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = submenu
        main.addItem(holder)
    }
}
