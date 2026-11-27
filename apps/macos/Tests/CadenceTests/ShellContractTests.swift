import JavaScriptCore
import XCTest
@testable import Cadence

// The values themselves are compared with the server, the web UI and the desktop app by
// apps/desktop/test/shell-contract.test.ts; here: what the Mac app does with them.
final class ShellContractTests: XCTestCase {
    private let line = #"CADENCE_LISTENING {"url":"http://127.0.0.1:28787","port":28787}"# + "\n"

    func testReadsThePortOnceTheWholeLineIsThere() {
        XCTAssertEqual(ShellContract.listeningPort(in: "(node) a warning\n" + line), 28787)
        XCTAssertEqual(ShellContract.listeningPort(in: line.replacingOccurrences(of: "\n", with: "\r\n")), 28787)
        XCTAssertNil(ShellContract.listeningPort(in: String(line.prefix(40))))
        XCTAssertNil(ShellContract.listeningPort(in: String(line.dropLast())))
    }

    func testIgnoresEverythingElse() {
        XCTAssertNil(ShellContract.listeningPort(in: "Error: listen EADDRINUSE: address already in use 127.0.0.1:28787\n"))
        XCTAssertNil(ShellContract.listeningPort(in: #"CADENCE_LISTENING {"url":"http://127.0.0.1:1"}"# + "\n"))
        XCTAssertNil(ShellContract.listeningPort(in: "CADENCE_LISTENING not json\n"))
    }

    func testServerEnvironmentStartsTheDesktopServerOnThisMachine() {
        let env = ShellContract.serverEnvironment(port: 28787, dataDirectory: URL(fileURLWithPath: "/data"),
                                                  webDirectory: URL(fileURLWithPath: "/web"), parentPid: 42)
        XCTAssertEqual(env["CADENCE_MODE"], "desktop")
        XCTAssertEqual(env["HOST"], "127.0.0.1")
        XCTAssertEqual(env["PORT"], "28787")
        XCTAssertEqual(env["CADENCE_DATA_DIR"], "/data")
        XCTAssertEqual(env["CADENCE_WEB_DIR"], "/web")
        XCTAssertEqual(env["CADENCE_PARENT_PID"], "42")
    }

    func testShellInfoIsValidJSONForThePage() throws {
        for remote in [nil, URL(string: "https://cadence.example.com")] {
            let info = ShellContract.shellInfo(version: "1.0.0", remote: remote)
            let data = try JSONSerialization.data(withJSONObject: info)
            let back = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(back["app"] as? String, "macos")
            XCTAssertEqual(back["remote"] as? String, remote?.absoluteString)
        }
    }

    func testMessagesTheBridgeKnows() {
        XCTAssertEqual(ShellContract.Message(rawValue: "pickImportFile"), .pickImportFile)
        XCTAssertEqual(ShellContract.Message(rawValue: "importReady"), .importReady)
        XCTAssertNil(ShellContract.Message(rawValue: "openFile"))
    }

    /// Names a page may give a file it saves → the name the app saves it under (nil: refused). The desktop app's
    /// test runs the same table (apps/desktop/test/shell-contract.test.ts checks that both have every case).
    private let savedNames: [(String, String?)] = [
        ("cadence-2026-06-20-morning-ride.png", "cadence-2026-06-20-morning-ride.png"),
        ("ecg-202606200815.csv", "ecg-202606200815.csv"),
        ("Morning Run.GPX", "Morning Run.GPX"),
        ("metrics.json", "metrics.json"),
        ("../../Library/LaunchAgents/evil.txt", "evil.txt"),
        ("C:\\Users\\me\\route.gpx", "route.gpx"),
        ("exports/run.csv/", nil),
        (".png", "cadence.png"),
        (".hidden.csv", "cadence.csv"),
        ("a<b>:c|d?e*f\"g.csv", "a_b__c_d_e_f_g.csv"),
        ("tab\there.txt", "tab_here.txt"),
        ("run.exe", nil),
        ("install.command", nil),
        ("page.html", nil),
        ("image.svg", nil),
        ("run.png.app", nil),
        ("run.png.", nil),
        ("noext", nil),
        ("", nil),
    ]

    func testSavedFilesKeepTheirNameAndTypeWithoutFolders() {
        for (name, saved) in savedNames {
            XCTAssertEqual(ShellContract.savedFileName(name), saved, name)
        }
        for type in ShellContract.savedFileTypes {
            XCTAssertEqual(ShellContract.savedFileName("export.\(type)"), "export.\(type)")
        }
    }

    /// A minimal page for the scripts the app runs with callAsyncJavaScript: a page that listens for `event` takes
    /// it (`received`); `location.assign` and `location.reload` are recorded.
    private func page(listeningFor event: String?) -> JSContext {
        let js = JSContext()!
        js.exceptionHandler = { _, e in XCTFail("script failed: \(e?.toString() ?? "")") }
        js.setObject(event ?? NSNull(), forKeyedSubscript: "listensFor" as NSString)
        js.evaluateScript("""
            var received = null, assigned = null, reloaded = false;
            var location = { assign: function (url) { assigned = url; }, reload: function () { reloaded = true; } };
            function CustomEvent(type, init) {
              this.type = type; this.detail = init.detail; this.cancelable = !!init.cancelable; this.defaultPrevented = false;
            }
            CustomEvent.prototype.preventDefault = function () { if (this.cancelable) this.defaultPrevented = true; };
            var window = {
              dispatchEvent: function (e) {
                if (e.type === listensFor) { received = e.detail; e.preventDefault(); }
                return !e.defaultPrevented;
              }
            };
            """)
        return js
    }

    /// Runs a script body (arguments `path`, `event`) in a page whose import page listens or not: what the script
    /// returned, what the import page received, where the page went.
    private func runImportScript(_ body: String, path: String, listening: Bool) -> (result: JSValue, received: JSValue, assigned: JSValue) {
        let js = page(listeningFor: listening ? ShellContract.importEvent : nil)
        let script = js.evaluateScript("(function (path, event) {\n\(body)\n})")!
        let result = script.call(withArguments: [path, ShellContract.importEvent])!
        return (result, js.objectForKeyedSubscript("received"), js.objectForKeyedSubscript("assigned"))
    }

    func testAPickedPathGoesToTheOpenImportPage() {
        let path = "/Users/me/Downloads/it's \"my\" export.zip"
        let run = runImportScript(ShellContract.offerImportScript, path: path, listening: true)
        XCTAssertTrue(run.result.toBool())
        XCTAssertEqual(run.received.forProperty("path").toString(), path)
        XCTAssertTrue(run.received.forProperty("confirm").isUndefined) // picked on the import page: imported at once
        XCTAssertTrue(run.assigned.isNull)
    }

    func testWithoutAnImportPageTheAppOpensOneThatAsksForThePath() {
        let run = runImportScript(ShellContract.offerImportScript, path: "/Users/me/export.zip", listening: false)
        XCTAssertFalse(run.result.toBool())
        XCTAssertEqual(run.assigned.toString(), "/import") // the path is in no URL
        let answer = runImportScript(ShellContract.handOverImportScript, path: "/Users/me/export.zip", listening: true)
        XCTAssertEqual(answer.received.forProperty("path").toString(), "/Users/me/export.zip")
        XCTAssertTrue(answer.received.forProperty("confirm").toBool()) // the page asks before it imports
        XCTAssertTrue(answer.assigned.isNull)
    }

    func testCancelEndsTheWaitOfThePageOrReloadsIt() {
        for listening in [true, false] {
            let js = page(listeningFor: listening ? ShellContract.cancelledEvent : nil)
            let script = js.evaluateScript("(function (type, event) {\n\(ShellContract.cancelledScript)\n})")!
            script.call(withArguments: [ShellContract.Message.connectServer.rawValue, ShellContract.cancelledEvent])
            if listening {
                XCTAssertEqual(js.objectForKeyedSubscript("received").forProperty("type").toString(), "connectServer")
            }
            // a page that does not listen (an older web UI of a remote server) starts afresh, as it did before
            XCTAssertEqual(js.objectForKeyedSubscript("reloaded").toBool(), !listening)
        }
    }
}
