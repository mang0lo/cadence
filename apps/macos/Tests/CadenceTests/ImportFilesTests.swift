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
