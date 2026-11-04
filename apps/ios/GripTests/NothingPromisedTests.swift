import Testing
import Foundation

/// Nothing in the app says "binnenkort" (plan 3 Task GAP): every placeholder
/// was replaced by the thing it promised, and the `ComingSoon` view is gone.
/// Read straight off the source tree, like `FixtureIsolationTests`, across
/// every target and the bundled fixtures and plists.
struct NothingPromisedTests {
    static let ios = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // GripTests/
        .deletingLastPathComponent()   // apps/ios/

    static let shipped = ["Grip", "GripWidget", "GripNotify", "GripShare"]
    static let extensions: Set<String> = ["swift", "json", "plist", "strings", "xcstrings"]
    // Spelled in two halves so this file is not its own match.
    static let promise = "binnen" + "kort"
    static let placeholder = "Coming" + "Soon"

    static func files() -> [URL] {
        shipped.flatMap { dir in
            (FileManager.default.enumerator(at: ios.appending(path: dir), includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL } ?? [])
                .filter { extensions.contains($0.pathExtension) }
        } + [ios.appending(path: "project.yml")]
    }

    @Test func theTreeIsReadable() {
        #expect(Self.files().count > 60)
    }

    @Test func nothingSaysBinnenkort() throws {
        for file in Self.files() {
            let text = try String(contentsOf: file, encoding: .utf8)
            #expect(!text.lowercased().contains(Self.promise), "\(file.lastPathComponent)")
            #expect(!text.contains(Self.placeholder), "\(file.lastPathComponent)")
        }
    }
}
