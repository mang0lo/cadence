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
        XCTAssertNil(ShellContract.Message(rawValue: "openFile"))
    }
}
