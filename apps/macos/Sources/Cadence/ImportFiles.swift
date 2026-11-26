import Foundation
import UniformTypeIdentifiers

/// What the Mac app hands to the built-in server's importer, which decides what it really is: Apple Health exports
/// (export.zip, export.xml or the unzipped folder) and FIT activities (a .fit file, or a zip or folder of them).
/// The app's Info.plist (scripts/build-macos.sh) declares the same types, so they can be dropped on the Dock icon.
///
/// No AppKit here: tested on its own (apps/macos/Tests/CadenceTests).
enum ImportFiles {
    static let extensions = ["zip", "xml", "fit"]

    /// A file or folder dropped on the Dock icon or opened with Cadence.
    static func accepts(_ url: URL) -> Bool {
        url.isFileURL && (url.hasDirectoryPath || extensions.contains(url.pathExtension.lowercased()))
    }

    /// The import panel's types. FIT has no type of its own in macOS: the app's Info.plist imports one, and a build
    /// without it (swift run) gets the dynamic type of the extension.
    static var contentTypes: [UTType] {
        [.folder] + extensions.compactMap { UTType(filenameExtension: $0) }
    }
}
