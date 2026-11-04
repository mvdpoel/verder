import Testing
import Foundation
import Synchronization
@testable import Verder

struct WidgetSnapshotTests {
    static func tempDir() -> URL {
        let dir = FileManager.default.temporaryDirectory.appending(path: "snap-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static let sample = WidgetSnapshot(count: 3, topTitle: "Loonstrook oktober aanleveren", topKind: "proposal",
                                       headline: "Stukken aanleveren",
                                       updatedAt: Date(timeIntervalSince1970: 1_793_352_001.123))

    @Test func snapshotRoundTrip() throws {
        let dir = Self.tempDir()
        try WidgetSnapshot.write(Self.sample, to: dir)
        #expect(WidgetSnapshot.read(from: dir) == Self.sample)
        // The file the widget reads, at the documented place in the group.
        #expect(FileManager.default.fileExists(atPath: dir.appending(path: "widget/snapshot.json").path()))
    }

    @Test func snapshotWithoutTitlesRoundTrips() throws {
        let dir = Self.tempDir()
        let empty = WidgetSnapshot(count: 0, topTitle: nil, topKind: nil, headline: nil,
                                   updatedAt: Date(timeIntervalSince1970: 1_793_352_001))
        try WidgetSnapshot.write(empty, to: dir)
        #expect(WidgetSnapshot.read(from: dir) == empty)
    }

    /// Sign-out leaves ONE empty file, so the widget can say "Log in bij
    /// verder" — and nothing of the case.
    @Test func theSignedOutMarkerIsEmpty() throws {
        let dir = Self.tempDir()
        try WidgetSnapshot.write(Self.sample, to: dir)
        #expect(!WidgetSnapshot.isSignedOut(in: dir))
        WidgetSnapshot.erase(in: dir)
        #expect(WidgetSnapshot.read(from: dir) == nil)
        #expect(WidgetSnapshot.isSignedOut(in: dir))
        let marker = try Data(contentsOf: WidgetSnapshot.signedOutURL(in: dir))
        #expect(marker.isEmpty)
        let left = try FileManager.default.contentsOfDirectory(atPath: dir.appending(path: "widget").path())
        #expect(left == ["signed-out"])
        // Signing in again: the next good refresh replaces the marker.
        try WidgetSnapshot.write(Self.sample, to: dir)
        #expect(!WidgetSnapshot.isSignedOut(in: dir))
    }

    @Test func itemDatesAndTheSporeRoundTripAndAnOlderItemStillReads() throws {
        let dir = Self.tempDir()
        let snap = WidgetSnapshot(count: 1, topTitle: nil, topKind: nil, headline: "Halte",
                                  updatedAt: Date(timeIntervalSince1970: 1_793_352_001),
                                  items: [.init(kind: "task", id: "x", title: "T",
                                                at: Date(timeIntervalSince1970: 1_793_352_000), dueAt: "2026-11-03")],
                                  headlineTrack: "Spoor", headlineAt: Date(timeIntervalSince1970: 1_793_000_000))
        try WidgetSnapshot.write(snap, to: dir)
        #expect(WidgetSnapshot.read(from: dir) == snap)
        let old = Data(#"{"count":1,"updatedAt":815100000,"items":[{"kind":"task","id":"x","title":"T"}]}"#.utf8)
        let decoded = try JSONDecoder().decode(WidgetSnapshot.self, from: old)
        #expect(decoded.items.first?.at == nil)
        #expect(decoded.headlineTrack == nil)
    }

    @Test func readIsNilWhenNothingWasWritten() {
        #expect(WidgetSnapshot.read(from: Self.tempDir()) == nil)
    }

    @Test func readIsNilForACorruptFile() throws {
        let dir = Self.tempDir()
        let file = WidgetSnapshot.fileURL(in: dir)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: file)
        #expect(WidgetSnapshot.read(from: dir) == nil)
    }

    /// The simulator does not enforce data protection and often reports no
    /// `protectionKey` at all, so reading the attribute back proves nothing:
    /// the options handed to the write are what is asserted. The class is
    /// checked on the device in Task 9.
    ///
    /// The protection classes are NOT independent bits — they are the values
    /// 1…4 in the top nibble (`UnlessOpen` = 0x3 contains `complete` = 0x2), so
    /// the class is compared as a whole, never with `contains`. The nibble is
    /// masked by hand: on the iOS 27 simulator `.fileProtectionMask` masked the
    /// until-first-auth value (0x40000000) down to 0 (measured 2026-10-31).
    @Test func snapshotIsWrittenAtomicallyUntilFirstUserAuthentication() throws {
        let seen = Mutex<[(URL, Data.WritingOptions)]>([])
        let dir = Self.tempDir()
        try WidgetSnapshot.write(Self.sample, to: dir) { _, url, options in
            seen.withLock { $0.append((url, options)) }
        }
        let calls = seen.withLock { $0 }
        #expect(calls.count == 1)
        let (url, options) = try #require(calls.first)
        #expect(url == WidgetSnapshot.fileURL(in: dir))
        #expect(options.contains(.atomic))
        let protection = options.rawValue & 0xF000_0000
        #expect(protection == Data.WritingOptions.completeFileProtectionUntilFirstUserAuthentication.rawValue)
        #expect(protection != Data.WritingOptions.completeFileProtection.rawValue)
    }
}
