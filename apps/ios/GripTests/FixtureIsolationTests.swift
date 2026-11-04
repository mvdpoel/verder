import Testing
import Foundation

/// Release never contains the fixture code path. The suite runs in Debug, so
/// it cannot look at a Release binary; it pins the two things that keep the
/// code out of one, straight off the source tree (the simulator test host can
/// read it, as `TokensMatchWebTests` does):
///
/// 1. every file in `Grip/Fixtures/` is wrapped whole in `#if DEBUG`, and
///    every OTHER source line that names a `Fixture…` type sits inside an
///    `#if DEBUG` region — so a Release compile cannot even see them;
/// 2. project.yml leaves `FixtureData` and `Fixture*.swift` out of the Release
///    configuration altogether, and every fixture file matches that pattern.
///
/// `scripts/check-release-fixtures.sh` checks the BUILT Release bundle.
struct FixtureIsolationTests {
    static let ios = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // GripTests/
        .deletingLastPathComponent()   // apps/ios/
    static let app = ios.appending(path: "Grip")

    static func swiftFiles(under dir: URL) -> [URL] {
        (FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL } ?? [])
            .filter { $0.pathExtension == "swift" }
    }

    static func lines(_ url: URL) throws -> [String] {
        try String(contentsOf: url, encoding: .utf8).components(separatedBy: .newlines)
    }

    /// Line numbers (0-based) of `text` that lie inside an `#if DEBUG` region,
    /// nested conditionals included. `#else` of `#if DEBUG` is NOT debug.
    static func debugLines(_ lines: [String]) -> Set<Int> {
        var stack: [Bool] = [] // per open #if: whether its current branch is DEBUG-only
        var out = Set<Int>()
        for (i, raw) in lines.enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#if") {
                stack.append(line == "#if DEBUG")
            } else if line.hasPrefix("#elseif") || line == "#else" {
                if !stack.isEmpty { stack[stack.count - 1] = false }
            } else if line == "#endif" {
                _ = stack.popLast()
            } else if stack.contains(true) {
                out.insert(i)
            }
        }
        return out
    }

    @Test func theSourceTreeIsReadable() {
        #expect(Self.swiftFiles(under: Self.app).count > 30)
    }

    @Test func everyFixtureFileIsWrappedWholeInIfDebug() throws {
        let files = Self.swiftFiles(under: Self.app.appending(path: "Fixtures"))
        #expect(files.count >= 4)
        for file in files {
            let code = try Self.lines(file).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            #expect(code.first == "#if DEBUG", "\(file.lastPathComponent) does not open with #if DEBUG")
            #expect(code.last == "#endif", "\(file.lastPathComponent) does not close with #endif")
            // The opening #if must close at the LAST line, not earlier.
            var depth = 0
            for (i, line) in code.enumerated() {
                if line.hasPrefix("#if") { depth += 1 }
                if line == "#endif" { depth -= 1 }
                if depth == 0 && i < code.count - 1 {
                    Issue.record("\(file.lastPathComponent): code after the #if DEBUG block closes (line \(i))")
                    break
                }
            }
            #expect(file.lastPathComponent.hasPrefix("Fixture"), "\(file.lastPathComponent) escapes Fixture*.swift")
        }
    }

    @Test func everyUseOutsideTheFolderIsInsideIfDebug() throws {
        let fixtures = Self.app.appending(path: "Fixtures").standardizedFileURL.path
        var uses = 0
        for file in Self.swiftFiles(under: Self.app) where !file.standardizedFileURL.path.hasPrefix(fixtures) {
            let lines = try Self.lines(file)
            let debug = Self.debugLines(lines)
            for (i, line) in lines.enumerated() {
                let code = line.trimmingCharacters(in: .whitespaces)
                if code.hasPrefix("//") { continue }
                guard code.contains(/\bFixture[A-Z]\w*/) || code.contains("-fixtures") else { continue }
                uses += 1
                #expect(debug.contains(i), "\(file.lastPathComponent):\(i + 1) uses fixture code outside #if DEBUG")
            }
        }
        #expect(uses > 0, "the app no longer reaches the fixtures at all — this test lost its subject")
    }

    @Test func releaseExcludesTheFixturesInProjectYml() throws {
        let yml = try String(contentsOf: Self.ios.appending(path: "project.yml"), encoding: .utf8)
        let line = try #require(yml.components(separatedBy: .newlines)
            .first { $0.contains("EXCLUDED_SOURCE_FILE_NAMES") })
        #expect(line.contains("FixtureData"))
        #expect(line.contains("Fixture*.swift"))
        // …and it sits under the Release config, not Debug.
        let before = yml[..<yml.range(of: line)!.lowerBound]
        let lastConfig = before.components(separatedBy: .newlines).last { $0.trimmingCharacters(in: .whitespaces).hasSuffix(":")
            && ["Release:", "Debug:"].contains($0.trimmingCharacters(in: .whitespaces)) }
        #expect(lastConfig?.trimmingCharacters(in: .whitespaces) == "Release:")
    }

    @Test func theScannerSeesNestingAndElse() {
        let src = ["a", "#if DEBUG", "b", "#if os(iOS)", "c", "#endif", "#else", "d", "#endif", "e"]
        #expect(Self.debugLines(src) == [2, 4])
    }
}
