import Testing
import Foundation
import PDFKit
import UIKit
@testable import Grip

/// The share extension's hand-off into the app's upload queue (plan 3 Task 22).
///
/// The extension never touches `queue.json` (the app holds it in memory and the
/// last writer would win); it leaves a DROP in `<group>/uploads/incoming/`, and
/// the app imports it with the drop's UUID as the upload's clientId.
struct IncomingDropTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    /// A group container with the queue where the app keeps it.
    func group() throws -> (group: URL, queue: UploadQueue) {
        let group = try scratchDir()
        return (group, UploadQueue(dir: group.appending(path: "uploads", directoryHint: .isDirectory)))
    }

    func incoming(_ group: URL) -> URL { IncomingDrop.directory(groupDir: group) }

    func files(_ dir: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.path())) ?? []).sorted()
    }

    // MARK: - The drop

    /// The JSON is written last: a `.bin` the extension is still writing (or
    /// died writing) is never imported, and never deleted while it is young.
    @Test func dropIsInvisibleUntilJsonWritten() async throws {
        let (group, queue) = try group()
        let id = try IncomingDrop.write(file: Data("%PDF-1.4 brief".utf8), fileName: "Brief.pdf",
                                        mime: "application/pdf", capturedAt: t0, to: group)
        let json = incoming(group).appending(path: "\(id.uuidString).json")
        let aside = group.appending(path: "aside.json")
        try FileManager.default.moveItem(at: json, to: aside)

        #expect(await queue.importIncoming().isEmpty)
        #expect(await queue.items().isEmpty)
        #expect(files(incoming(group)) == ["\(id.uuidString).bin"])

        try FileManager.default.moveItem(at: aside, to: json)
        #expect(await queue.importIncoming().map(\.id) == [id])
    }

    @Test func importIncomingKeepsTheDropUUIDAsClientId() async throws {
        let (group, queue) = try group()
        let id = try IncomingDrop.write(file: Data("PK sheet".utf8), fileName: "Afschrift.xlsx",
                                        mime: xlsxMime, capturedAt: t0, to: group)
        await queue.importIncoming()

        let item = try #require(await queue.items().first)
        #expect(item.id == id)
        #expect(item.clientId == id.uuidString.lowercased())
        #expect(item.source == "phone-share")
        #expect(item.fileName == "Afschrift.xlsx")
        #expect(item.resolvedMime == xlsxMime)
        #expect(item.resolvedExtension == "xlsx")
        #expect(item.capturedAt == t0)
        #expect(item.state == .pending)
        #expect(try Data(contentsOf: queue.fileURL(item)) == Data("PK sheet".utf8))
    }

    /// A crash after `enqueue` and before the drop is deleted imports it again:
    /// that must give the SAME one item, not a second upload.
    @Test func importIsIdempotent() async throws {
        let (group, queue) = try group()
        let id = try IncomingDrop.write(file: Data("%PDF".utf8), fileName: "Brief.pdf",
                                        mime: "application/pdf", capturedAt: t0, to: group)
        let json = incoming(group).appending(path: "\(id.uuidString).json")
        let bin = incoming(group).appending(path: "\(id.uuidString).bin")
        let keepJSON = try Data(contentsOf: json), keepBin = try Data(contentsOf: bin)

        await queue.importIncoming()
        // The crash: the drop is still there on the next launch.
        try keepJSON.write(to: json)
        try keepBin.write(to: bin)
        await queue.importIncoming()

        #expect(await queue.items().map(\.id) == [id])
        // …and it survives a relaunch as one item.
        #expect(await UploadQueue(dir: queue.dir).items().map(\.id) == [id])
    }

    /// A second enqueue with an id already queued writes nothing — not even
    /// the file, which may already have been sent and deleted.
    @Test func enqueueWithAQueuedIdReturnsTheExistingItem() async throws {
        let (_, queue) = try group()
        let id = UUID()
        let first = try await queue.enqueue(file: Data("one".utf8), id: id, fileName: "a.pdf", mime: "application/pdf",
                                            fileExtension: "pdf", capturedAt: t0, source: "phone-share")
        _ = await queue.claimDue(now: t0)
        await queue.markSent(id, now: t0)
        let again = try await queue.enqueue(file: Data("two".utf8), id: id, fileName: "b.pdf", mime: "application/pdf",
                                            fileExtension: "pdf", capturedAt: t0, source: "phone-share")
        #expect(again.id == first.id)
        #expect(again.state == .sent)
        #expect(await queue.items().count == 1)
        #expect(!FileManager.default.fileExists(atPath: queue.fileURL(again).path()))
    }

    @Test func importDeletesTheDropAfterEnqueue() async throws {
        let (group, queue) = try group()
        _ = try IncomingDrop.write(file: Data("%PDF".utf8), fileName: "Brief.pdf",
                                   mime: "application/pdf", capturedAt: t0, to: group)
        _ = try IncomingDrop.write(file: Data("%PDF 2".utf8), fileName: "Brief 2.pdf",
                                   mime: "application/pdf", capturedAt: t0, to: group)
        #expect(await queue.importIncoming().count == 2)
        #expect(files(incoming(group)).isEmpty)
        #expect(await queue.items().count == 2)
    }

    /// The extension already delivered it: the app records it as sent rather
    /// than uploading the bytes a second time.
    @Test func aDropTheExtensionSentArrivesAsSent() async throws {
        let (group, queue) = try group()
        let id = try IncomingDrop.write(file: Data("%PDF".utf8), fileName: "Brief.pdf",
                                        mime: "application/pdf", capturedAt: t0, to: group)
        try IncomingDrop.markSent(id, groupDir: group)
        await queue.importIncoming(now: t0)

        let item = try #require(await queue.items().first)
        #expect(item.state == .sent)
        #expect(item.sentAt == t0)
        #expect(await queue.claimDue(now: t0).isEmpty)
        #expect(files(incoming(group)).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: queue.fileURL(item).path()))
    }

    /// A `.bin` with no `.json` is either still being written or the leftover
    /// of a crash mid-cleanup. Only age tells them apart.
    @Test func orphanBinIsSweptOnlyAfter24h() async throws {
        let (group, queue) = try group()
        let dir = incoming(group)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let orphan = dir.appending(path: "\(UUID().uuidString).bin")
        let sent = dir.appending(path: "\(UUID().uuidString).sent")
        try Data("half".utf8).write(to: orphan)
        try Data().write(to: sent)

        await queue.importIncoming(now: Date().addingTimeInterval(23 * 3600))
        #expect(FileManager.default.fileExists(atPath: orphan.path()))
        #expect(FileManager.default.fileExists(atPath: sent.path()))

        await queue.importIncoming(now: Date().addingTimeInterval(25 * 3600))
        #expect(!FileManager.default.fileExists(atPath: orphan.path()))
        #expect(!FileManager.default.fileExists(atPath: sent.path()))
        #expect(await queue.items().isEmpty)
    }

    /// The extension a file is stored under is never trusted as a path: a
    /// shared `x.body` must not land on the uploader's multipart body file.
    @Test func extensionsAreSanitised() {
        #expect(IncomingDrop.fileExtension(fileName: "Afschrift.XLSX", mime: "") == "xlsx")
        #expect(IncomingDrop.fileExtension(fileName: "brief", mime: "application/pdf") == "pdf")
        #expect(IncomingDrop.fileExtension(fileName: "x.body", mime: "") == "bin")
        #expect(IncomingDrop.fileExtension(fileName: "x.json", mime: "") == "bin")
        #expect(IncomingDrop.fileExtension(fileName: "../../evil", mime: "") == "bin")
        #expect(UploadItem.safeExtension("p/df") == nil)
        #expect(UploadItem.safeExtension("averyveryverylongext") == nil)
    }

    // MARK: - What the share sheet hands over

    /// Photos become ONE PDF through PDFAssembler; a PDF passes through as it came.
    @Test func imagesBecomeOnePDF() throws {
        let page = Fixture.letterPageURL
        let pdf = Data("%PDF-1.4 mailed".utf8)
        let prepared = SharePreparation.prepare(
            [.photo(url: page), .file(data: pdf, fileName: "Beschikking.pdf", mime: "application/pdf"), .photo(url: page)],
            capturedAt: t0).files

        #expect(prepared.count == 2)
        let photos = try #require(prepared.first { $0.mime == "application/pdf" && $0.data != pdf })
        #expect(photos.fileName == "Gedeeld 15 jan 09.00.pdf")
        let photoData = try #require(photos.data)
        let doc = try #require(PDFDocument(data: photoData))
        #expect(doc.pageCount == 2)
        let passed = try #require(prepared.first { $0.fileName == "Beschikking.pdf" })
        #expect(passed.data == pdf)
    }

    @Test func otherFilesPassThroughWithTheirOwnMime() {
        let prepared = SharePreparation.prepare(
            [.file(data: Data("PK".utf8), fileName: "Afschrift.xlsx", mime: xlsxMime)], capturedAt: t0).files
        #expect(prepared == [PreparedShare(data: Data("PK".utf8), fileName: "Afschrift.xlsx", mime: xlsxMime)])
    }

    // MARK: - The queue before this task

    /// `UploadQueue.init` decodes with `try? … ?? Index()`: a field the old
    /// `queue.json` lacks that is not optional would SILENTLY EMPTY the queue.
    /// The fixture is the shape the build before Task 22 wrote.
    @Test func oldQueueJsonStillDecodes() async throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "Fixtures/queue-before-share.json")
        let dir = try scratchDir()
        try FileManager.default.copyItem(at: fixture, to: dir.appending(path: "queue.json"))

        let items = await UploadQueue(dir: dir, now: t0).items()
        #expect(items.count == 4)
        #expect(items.map(\.state) == [.pending, .pending, .failed, .sent])
        #expect(items[1].attempts == 2)
        #expect(items[1].nextAttemptAt == Date(timeIntervalSince1970: 1_800_000_000 + 900))
        #expect(items[3].sentAt != nil)
        for item in items {
            #expect(item.mime == nil)
            #expect(item.fileExtension == nil)
            #expect(item.resolvedMime == "application/pdf")
            #expect(UploadQueue(dir: dir).fileURL(item).lastPathComponent == "\(item.id.uuidString).pdf")
        }
    }

    // MARK: - On the wire

    @Test func sharedXlsxIsUploadedWithItsOwnMime() async throws {
        let server = StubServer()
        server.on { _ in .status(200, body: Data(#"{"id":"doc-1","duplicate":false}"#.utf8)) }
        let (group, queue) = try group()
        let id = try IncomingDrop.write(file: Data("PK sheet".utf8), fileName: "Afschrift.xlsx",
                                        mime: xlsxMime, capturedAt: t0, to: group)
        await queue.importIncoming()
        let config = APIClient.sessionConfiguration()
        config.protocolClasses = [StubProtocol.self]
        let up = BackgroundUploader(queue: queue, client: server.client(), configuration: config)

        await up.drain()

        let text = String(decoding: try #require(server.requests.first?.httpBody), as: UTF8.self)
        #expect(text.contains("name=\"clientId\"\r\n\r\n\(id.uuidString.lowercased())\r\n"))
        #expect(text.contains("name=\"source\"\r\n\r\nphone-share\r\n"))
        #expect(text.contains("filename=\"Afschrift.xlsx\"\r\nContent-Type: \(xlsxMime)\r\n\r\nPK sheet"))
        #expect(!text.contains("application/pdf"))
        let item = try #require(await queue.items().first)
        #expect(item.state == .sent)
        #expect(!FileManager.default.fileExists(atPath: queue.fileURL(item).path()))
    }

    /// The extension's own attempt: a 2xx leaves `<uuid>.sent` beside the drop.
    @Test func extensionUploadMarksTheDropSentOn2xx() async throws {
        let server = StubServer()
        server.on { _ in .status(200, body: Data(#"{"id":"doc-1","duplicate":false}"#.utf8)) }
        let group = try scratchDir()
        let id = try IncomingDrop.write(file: Data("%PDF".utf8), fileName: "Brief.pdf",
                                        mime: "application/pdf", capturedAt: t0, to: group)

        let sent = await ShareSender.send([id], groupDir: group, client: server.client())

        #expect(sent == [id])
        #expect(FileManager.default.fileExists(atPath: incoming(group).appending(path: "\(id.uuidString).sent").path()))
        let text = String(decoding: try #require(server.requests.first?.httpBody), as: UTF8.self)
        #expect(text.contains("name=\"clientId\"\r\n\r\n\(id.uuidString.lowercased())\r\n"))
        #expect(text.contains("name=\"source\"\r\n\r\nphone-share\r\n"))
    }

    /// Not signed in (or offline): nothing is marked, and the drop stays for
    /// the app's queue, which knows how to wait.
    @Test func extensionUploadLeavesTheDropOnFailure() async throws {
        let server = StubServer()
        server.on { _ in .status(401) }
        let group = try scratchDir()
        let id = try IncomingDrop.write(file: Data("%PDF".utf8), fileName: "Brief.pdf",
                                        mime: "application/pdf", capturedAt: t0, to: group)

        #expect(await ShareSender.send([id], groupDir: group, client: server.client()).isEmpty)
        #expect(files(incoming(group)) == ["\(id.uuidString).bin", "\(id.uuidString).json"])
    }

    /// A drop over the extension's foreground limit is never read or sent by
    /// the extension: the app's queue streams it from a file instead.
    @Test func extensionLeavesALargeDropToTheApp() async throws {
        let server = StubServer()
        server.on { _ in .status(200, body: Data(#"{"id":"doc-1","duplicate":false}"#.utf8)) }
        let group = try scratchDir()
        let small = try IncomingDrop.write(file: Data("%PDF".utf8), fileName: "Klein.pdf",
                                           mime: "application/pdf", capturedAt: t0, to: group)
        let large = try IncomingDrop.write(file: Data(count: 64), fileName: "Groot.pdf",
                                           mime: "application/pdf", capturedAt: t0, to: group)

        let sent = await ShareSender.send([small, large], groupDir: group, client: server.client(),
                                          foregroundLimit: 32)

        #expect(sent == [small])
        #expect(server.requests.count == 1)
        #expect(!FileManager.default.fileExists(atPath: incoming(group).appending(path: "\(large.uuidString).sent").path()))
        #expect(ShareSender.foregroundLimit < ShareModel.maxFileBytes)
    }

    /// A staged file goes into its drop by COPY, never through memory, and
    /// arrives byte for byte.
    @Test func aFileDropIsCopiedByteForByte() async throws {
        let (group, queue) = try group()
        let source = try scratchDir().appending(path: "Afschrift.xlsx")
        let bytes = Data("PK staged sheet".utf8)
        try bytes.write(to: source)

        let id = try IncomingDrop.write(fileAt: source, fileName: "Afschrift.xlsx", mime: xlsxMime,
                                        capturedAt: t0, to: group)

        #expect(try Data(contentsOf: incoming(group).appending(path: "\(id.uuidString).bin")) == bytes)
        #expect(FileManager.default.fileExists(atPath: source.path()))
        let item = try #require(await queue.importIncoming().first)
        #expect(item.id == id)
        #expect(item.resolvedExtension == "xlsx")
    }

    // MARK: - Staging: measured before it is read

    /// A file over the limit is refused on its metadata: nothing is copied
    /// (and nothing read), so a 200 MB video cannot kill the extension first.
    @Test func anOversizedFileIsRefusedWithoutBeingCopied() throws {
        let source = try scratchDir().appending(path: "video.mov")
        FileManager.default.createFile(atPath: source.path(), contents: nil)
        let handle = try FileHandle(forWritingTo: source)
        try handle.truncate(atOffset: 200 * 1024 * 1024)   // sparse: no 200 MB written
        try handle.close()
        let staging = try scratchDir()

        let input = ShareStaging.stage(source, fileName: "video.mov", mime: "video/quicktime", into: staging)

        guard case .tooLarge(let name, let bytes, _) = input else { Issue.record("expected tooLarge, got \(input)"); return }
        #expect(name == "video.mov")
        #expect(bytes == 200 * 1024 * 1024)
        #expect(files(staging).isEmpty)
    }

    @Test func aFileUnderTheLimitIsStagedAsACopy() throws {
        let source = try scratchDir().appending(path: "Brief.pdf")
        try Data("%PDF-1.4 brief".utf8).write(to: source)
        let staging = try scratchDir()

        let input = ShareStaging.stage(source, fileName: "Brief.pdf", mime: "application/pdf", into: staging)

        guard case .staged(let url, let name, let mime, let bytes) = input else {
            Issue.record("expected staged, got \(input)"); return
        }
        #expect(url.deletingLastPathComponent().standardizedFileURL == staging.standardizedFileURL)
        #expect((name, mime, bytes) == ("Brief.pdf", "application/pdf", 14))
        #expect(try Data(contentsOf: url) == Data("%PDF-1.4 brief".utf8))
    }

    @Test func aMissingFileStagesAsUnreadable() throws {
        let staging = try scratchDir()
        let input = ShareStaging.stage(staging.appending(path: "gone.pdf"), fileName: "gone.pdf",
                                       mime: "application/pdf", into: staging)
        guard case .unreadable = input else { Issue.record("expected unreadable, got \(input)"); return }
    }

    // MARK: - Collecting what the share sheet handed over

    /// Every item handed over is an input, in order: a load that fails is
    /// `.unreadable` in its place, never skipped and never cut at ten.
    @Test func collectKeepsAFailedLoadAsUnreadable() async {
        let inputs = await SharePreparation.collect(count: 3) { index in
            index == 1 ? nil : .file(data: Data("%PDF".utf8), fileName: "\(index).pdf", mime: "application/pdf")
        }
        #expect(inputs.count == 3)
        guard case .unreadable = inputs[1] else { Issue.record("expected unreadable at 1"); return }
        guard case .file(_, let first, _) = inputs[0], case .file(_, let last, _) = inputs[2] else {
            Issue.record("expected files around it"); return
        }
        #expect((first, last) == ("0.pdf", "2.pdf"))
    }

    @Test func collectLoadsEveryItemPastTen() async {
        let loaded = await SharePreparation.collect(count: 12) { _ in .unreadable }
        #expect(loaded.count == 12)
    }
}
