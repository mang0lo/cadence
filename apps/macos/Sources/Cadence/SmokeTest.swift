import AppKit
import WebKit

/// CADENCE_SMOKE=<file.png> (CI): the app starts its built-in server, loads the web UI and waits until the app shell
/// rendered, saves a screenshot to that file and quits with exit code 0 (printing `CADENCE_SMOKE_OK`). When the server
/// does not start or stops, or the UI does not render within two minutes, it quits with 1 (`CADENCE_SMOKE_FAILED`).
///
/// A smoke run leaves nothing behind: it shows no window and takes no focus, ignores a remote server, keeps the
/// preferences in memory and the website data in an ephemeral store; with CADENCE_DATA_DIR the database and the
/// server log go to that folder (ServerProcess).
@MainActor
final class SmokeTest {
    /// Where the screenshot goes; nil for a normal start.
    nonisolated static let screenshot: String? = {
        let path = ProcessInfo.processInfo.environment["CADENCE_SMOKE"] ?? ""
        return path.isEmpty ? nil : path
    }()

    nonisolated static var isActive: Bool { screenshot != nil }

    /// The rendered app shell (sidebar navigation and main area): not a blank page, an error page or the login page.
    /// The same marker as the desktop app's smoke test (apps/desktop/src/main.ts).
    private static let ready = "!!document.querySelector('aside nav a[href]') && !!document.querySelector('main')"

    private let webView: WKWebView
    private let finish: (Int32) -> Void
    private let deadline = Date().addingTimeInterval(120)
    private var done = false

    /// `finish` stops the server and ends the app with the exit code.
    init(webView: WKWebView, finish: @escaping (Int32) -> Void) {
        self.webView = webView
        self.finish = finish
    }

    func start() {
        poll()
    }

    func fail(_ reason: String) {
        guard !done else { return }
        done = true
        Self.say("CADENCE_SMOKE_FAILED \(reason)")
        finish(1)
    }

    private func poll() {
        guard !done else { return }
        guard Date() < deadline else { return fail("the app did not render within 120 seconds") }
        webView.evaluateJavaScript(Self.ready) { [weak self] result, _ in
            guard let self else { return }
            if (result as? Bool) == true {
                // the first page draws its content for the screenshot
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.capture() }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.poll() }
            }
        }
    }

    private func capture() {
        guard !done else { return }
        webView.takeSnapshot(with: nil) { [weak self] image, error in
            guard let self, !self.done else { return }
            guard let tiff = image?.tiffRepresentation,
                  let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]),
                  let path = Self.screenshot,
                  (try? png.write(to: URL(fileURLWithPath: path))) != nil else {
                return self.fail("no screenshot of the rendered app (\(error?.localizedDescription ?? "no image"))")
            }
            self.done = true
            let size = image.map { "\(Int($0.size.width))x\(Int($0.size.height))" } ?? ""
            Self.say("CADENCE_SMOKE_OK \(self.webView.url?.absoluteString ?? "") \(size)")
            self.finish(0)
        }
    }

    /// Unbuffered, so the line is in the CI log even when the app ends right after.
    nonisolated static func say(_ line: String) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}
