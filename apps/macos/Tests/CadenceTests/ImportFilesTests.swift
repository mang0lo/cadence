import UniformTypeIdentifiers
import XCTest
@testable import Cadence

final class ImportFilesTests: XCTestCase {
    func testAcceptsWhatTheImporterReads() {
        for path in ["/Users/me/Downloads/export.zip", "/Users/me/Downloads/Export.ZIP", "/Users/me/export.xml",
                     "/Users/me/COROS/Run 2024-05-01.fit", "/Users/me/Garmin/ACTIVITY.FIT"] {
            XCTAssertTrue(ImportFiles.accepts(URL(fileURLWithPath: path)), path)
        }
        // the unzipped export, or a folder of FIT files
        XCTAssertTrue(ImportFiles.accepts(URL(fileURLWithPath: "/Users/me/apple_health_export", isDirectory: true)))
    }

    func testRejectsOtherFiles() {
        for path in ["/Users/me/Downloads/report.pdf", "/Users/me/route.gpx", "/Users/me/fit", "/Users/me/export.xml.txt"] {
            XCTAssertFalse(ImportFiles.accepts(URL(fileURLWithPath: path)), path)
        }
        XCTAssertFalse(ImportFiles.accepts(URL(string: "https://example.com/export.zip")!))
    }

    /// The Info.plist scripts/build-macos.sh writes into the app, its variables filled in.
    private func appInfoPlist() throws -> [String: Any] {
        var repo = URL(fileURLWithPath: #filePath) // <repo>/apps/macos/Tests/CadenceTests/ImportFilesTests.swift
        for _ in 0..<5 { repo.deleteLastPathComponent() }
        let script = try String(contentsOf: repo.appendingPathComponent("scripts/build-macos.sh"), encoding: .utf8)
        let start = try XCTUnwrap(script.range(of: "<<PLIST\n"))
        let end = try XCTUnwrap(script.range(of: "\nPLIST\n", range: start.upperBound..<script.endIndex))
        let xml = script[start.upperBound..<end.lowerBound].replacingOccurrences(of: "$VERSION", with: "1.0.0")
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(xml.utf8), format: nil) as? [String: Any])
    }

    func testTheDockIconTakesWhatTheImporterReads() throws {
        let documentTypes = try XCTUnwrap(appInfoPlist()["CFBundleDocumentTypes"] as? [[String: Any]])
        var rank: [String: String] = [:]
        for type in documentTypes {
            for id in type["LSItemContentTypes"] as? [String] ?? [] { rank[id] = type["LSHandlerRank"] as? String }
        }
        let declared = ["zip": "public.zip-archive", "xml": "public.xml", "fit": "com.garmin.fit"]
        XCTAssertEqual(Set(declared.keys), Set(ImportFiles.extensions))
        for id in declared.values { XCTAssertEqual(rank[id], "Alternate", id) }
        // folders (the unzipped export, a folder of FIT files) can be dropped, but Cadence never opens folders otherwise
        XCTAssertEqual(rank["public.folder"], "None")
    }

    func testThePanelOffersFitFilesFoldersAndExports() {
        let types = ImportFiles.contentTypes
        for ext in ["fit", "zip", "xml"] {
            let type = UTType(filenameExtension: ext)!
            XCTAssertTrue(types.contains { type.conforms(to: $0) }, ext)
        }
        XCTAssertTrue(types.contains { UTType.folder.conforms(to: $0) })
        XCTAssertFalse(types.contains { UTType.pdf.conforms(to: $0) })
    }
}
