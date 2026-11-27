import XCTest
@testable import Cadence

final class ShellPolicyTests: XCTestCase {
    private let local = [ShellPolicy.Origin(URL(string: "http://127.0.0.1:28787/"))!]

    private func origin(_ s: String) -> ShellPolicy.Origin? { ShellPolicy.Origin(URL(string: s)) }

    func testOriginFillsInDefaultPortsLikeWebKit() {
        XCTAssertEqual(origin("http://127.0.0.1:28787/import?x=1")?.description, "http://127.0.0.1:28787")
        XCTAssertEqual(origin("https://Cadence.Example.com/"), origin("https://cadence.example.com:443/"))
        // WKSecurityOrigin reports a default port as 0
        XCTAssertEqual(ShellPolicy.Origin(scheme: "https", host: "cadence.example.com", port: 0), origin("https://cadence.example.com/"))
        XCTAssertEqual(ShellPolicy.Origin(scheme: "http", host: "[::1]", port: 8787), origin("http://[::1]:8787/"))
        XCTAssertNil(origin("file:///etc/passwd"))
        XCTAssertNil(origin("about:blank"))
    }

    func testAppPagesStayInTheWindow() {
        let url = URL(string: "http://127.0.0.1:28787/activities/1")!
        XCTAssertEqual(ShellPolicy.navigation(to: url, userAction: true, appOrigins: local), .allow)
        XCTAssertEqual(ShellPolicy.navigation(to: url, userAction: false, appOrigins: local), .allow)
    }

    func testLinksToOtherSitesOpenInTheBrowser() {
        for s in ["https://www.openstreetmap.org/copyright", "http://127.0.0.1:8787/", "https://127.0.0.1:28787/",
                  "http://127.0.0.1:28787@evil.example/", "mailto:someone@example.com"] {
            XCTAssertEqual(ShellPolicy.navigation(to: URL(string: s)!, userAction: true, appOrigins: local), .openExternally, s)
        }
    }

    func testRedirectsAndScriptsMayLoadOtherSitesButNeverHandThemToTheSystem() {
        // e.g. an auth gateway in front of a remote server: the page loads, but gets no bridge (see below)
        XCTAssertEqual(ShellPolicy.navigation(to: URL(string: "https://auth.example.com/login")!, userAction: false, appOrigins: local), .allow)
        XCTAssertEqual(ShellPolicy.navigation(to: URL(string: "mailto:x@example.com")!, userAction: false, appOrigins: local), .cancel)
        XCTAssertEqual(ShellPolicy.navigation(to: URL(string: "about:blank")!, userAction: false, appOrigins: local), .allow)
    }

    func testOtherSchemesNeverLeaveTheApp() {
        for s in ["file:///Applications/Calculator.app", "smb://evil/share", "vnc://evil", "ssh://evil",
                  "x-apple.systempreferences:com.apple.preference.security", "itms-services://?action=download-manifest"] {
            let url = URL(string: s)!
            XCTAssertFalse(ShellPolicy.isExternal(url), s)
            XCTAssertEqual(ShellPolicy.navigation(to: url, userAction: true, appOrigins: local), .cancel, s)
        }
        XCTAssertTrue(ShellPolicy.isExternal(URL(string: "https://github.com/mang0lo/cadence")!))
        XCTAssertTrue(ShellPolicy.isExternal(URL(string: "mailto:x@example.com")!))
    }

    func testBridgeOnlyForTheMainFrameOfAnAppPage() {
        let app = ShellPolicy.Origin(scheme: "http", host: "127.0.0.1", port: 28787)
        XCTAssertTrue(ShellPolicy.acceptsMessage(isMainFrame: true, from: app, appOrigins: local))
        XCTAssertFalse(ShellPolicy.acceptsMessage(isMainFrame: false, from: app, appOrigins: local))
        XCTAssertFalse(ShellPolicy.acceptsMessage(isMainFrame: true, from: origin("https://evil.example/"), appOrigins: local))
        XCTAssertFalse(ShellPolicy.acceptsMessage(isMainFrame: true, from: nil, appOrigins: local))
        XCTAssertFalse(ShellPolicy.acceptsMessage(isMainFrame: true, from: app, appOrigins: []))
    }

    func testDownloadsOnlyForTheMainFrameOfAnAppPage() {
        let app = ShellPolicy.Origin(scheme: "http", host: "127.0.0.1", port: 28787)
        XCTAssertTrue(ShellPolicy.allowsDownload(isMainFrame: true, from: app, appOrigins: local))
        // a frame inside the page, another site in the window (e.g. after a redirect), a page without an origin
        XCTAssertFalse(ShellPolicy.allowsDownload(isMainFrame: false, from: app, appOrigins: local))
        XCTAssertFalse(ShellPolicy.allowsDownload(isMainFrame: true, from: origin("https://evil.example/"), appOrigins: local))
        XCTAssertFalse(ShellPolicy.allowsDownload(isMainFrame: true, from: nil, appOrigins: local))
    }

    func testADownloadTheAppPageMadeComesFromThatPage() {
        let page = URL(string: "http://127.0.0.1:28787/health/ecg")!
        // GPX and backup links, attachments: the origin of their URL
        XCTAssertEqual(ShellPolicy.downloadOrigin(of: URL(string: "http://127.0.0.1:28787/api/backup"), shownPage: page), local[0])
        XCTAssertEqual(ShellPolicy.downloadOrigin(of: URL(string: "https://evil.example/x.zip"), shownPage: page),
                       origin("https://evil.example/"))
        // the ECG as CSV (a data: URL), blobs: the page that made them
        for s in ["data:text/csv;charset=utf-8;base64,YSxi", "blob:http://127.0.0.1:28787/0b6e4c1e-5f3a-4f0e-9d2c-1a2b3c4d5e6f"] {
            XCTAssertEqual(ShellPolicy.downloadOrigin(of: URL(string: s), shownPage: page), local[0], s)
        }
        XCTAssertNil(ShellPolicy.downloadOrigin(of: URL(string: "file:///etc/passwd"), shownPage: page))
        XCTAssertNil(ShellPolicy.downloadOrigin(of: nil, shownPage: page))
    }

    func testTheOriginAServerRedirectedTheAppToCountsAsTheApp() {
        let origins = [origin("http://cadence.example.com/")!, origin("https://cadence.example.com/")!]
        XCTAssertEqual(ShellPolicy.navigation(to: URL(string: "https://cadence.example.com/settings")!, userAction: true, appOrigins: origins), .allow)
        XCTAssertTrue(ShellPolicy.acceptsMessage(isMainFrame: true, from: origin("https://cadence.example.com/"), appOrigins: origins))
    }
}
