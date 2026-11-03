import Testing
import Foundation
import UIKit
@testable import Verder

/// The words of every "scan · final" frame, read from `ScanScreen` and
/// `QueueSheet` without a simulator. The frames' clock: Sun 1 nov 2026.
struct ScanScreenTests {
    static func at(_ hhmm: String) -> Date { FixtureEnvironment.amsterdam(hhmm) }

    static func item(_ at: String, _ state: UploadItem.State, pages: Int? = 1, sentAt: String? = nil,
                     bytes: Int? = nil, failure: UploadItem.Failure? = nil, note: String? = nil,
                     source: String = "phone-scan") -> UploadItem {
        UploadItem(id: UUID(), fileName: "Scan \(at).pdf", capturedAt: Self.at(at), source: source, state: state,
                   attempts: 0, nextAttemptAt: nil, sentAt: sentAt.map(Self.at), pages: pages, byteCount: bytes,
                   failure: failure, documentId: state == .sent ? "doc-\(at)" : nil, note: note)
    }

    static func input(_ items: [UploadItem], now: String, signIn: Bool = false, offline: Bool = false,
                      ever: Bool = true) -> ScanScreen.Input {
        ScanScreen.Input(items: items, signInRequired: signIn, offline: offline, everEnqueued: ever, now: at(now))
    }

    static let nine = ["09:05", "09:30", "10:02", "10:40", "11:15", "11:48", "11:58", "12:02"]
        .map { item($0, .sent, sentAt: $0) } + [item("13:10", .sent, pages: 3, sentAt: "13:11")]

    @Test func eersteKeer() {
        let s = ScanScreen(Self.input([], now: "14:50", ever: false))
        #expect(s.eyebrow == "zondag 1 nov")
        #expect(s.slot == .none)
        #expect(s.discTitle == "Nog geen scans — scan je eerste brief")
        #expect(s.discSubtitle == "Leg de brief plat neer, de camera doet de rest.")
        #expect(s.duplex.label == "Dubbelzijdig")
        #expect(s.accessory == nil)
        // Once anything was queued, an empty queue is no longer "the first".
        #expect(ScanScreen(Self.input([], now: "14:50", ever: true)).discTitle == "Scan een brief")
    }

    @Test func eenInDeWachtrij() throws {
        let fresh = Self.item("14:32", .pending, pages: 2, bytes: 1_400_000)
        let s = ScanScreen(Self.input([Self.item("12:02", .sent, sentAt: "12:02"), fresh], now: "14:34"))
        #expect(s.slot == .note(fresh.id, time: "14:32"))
        #expect(s.discTitle == "Volgende brief scannen")
        #expect(s.discSubtitle == nil)
        #expect(s.duplex.label == "Dubbelzijdig · nog 8 min")
        #expect(s.duplex.text.hasPrefix("Achterkanten van deze brief?"))
        let a = try #require(s.accessory)
        #expect(a.title == "1 scan wordt verstuurd")
        #expect(a.meta == "2 pagina's · scan 14:32")
        #expect(a.compactTitle == "1 bezig")
        #expect(a.action == nil)
        // A note already given: the chip has nothing left to ask.
        var noted = fresh
        noted.note = "Kwam aangetekend"
        #expect(ScanScreen(Self.input([noted], now: "14:34")).slot == .none)
    }

    @Test func theDuplexWindowCloses() {
        let s = ScanScreen(Self.input([Self.item("14:32", .pending)], now: "14:42"))
        #expect(s.discTitle == "Scan een brief")
        #expect(s.duplex.label == "Dubbelzijdig")
        // The last minute still says "nog 1 min", never "nog 0".
        #expect(ScanScreen(Self.input([Self.item("14:32", .pending)], now: "14:41")).duplex.label == "Dubbelzijdig · nog 1 min")
        // A shared PDF is not a capture: no duplex promise for it.
        #expect(ScanScreen(Self.input([Self.item("14:32", .pending, source: "phone-share")], now: "14:33")).recent == nil)
    }

    @Test func wachtrijLeeg() throws {
        let items = [Self.item("12:02", .sent, sentAt: "12:02"), Self.item("13:10", .sent, pages: 3, sentAt: "13:11"),
                     Self.item("14:32", .sent, pages: 2, sentAt: "14:33")]
        let a = try #require(ScanScreen(Self.input(items, now: "14:50")).accessory)
        #expect(a.symbol == "checkmark.circle")
        #expect(a.title == "Alles is verstuurd")
        #expect(a.meta == "Vandaag 3 scans · laatste 14:32")
        // Yesterday's sends are not today's.
        var old = items[0]
        old.sentAt = Self.at("00:00").addingTimeInterval(-3600)
        #expect(ScanScreen(Self.input([old], now: "14:50")).accessory == nil)
    }

    @Test func offline() throws {
        let items = Self.nine + [Self.item("14:32", .pending), Self.item("14:36", .pending), Self.item("14:41", .pending)]
        let s = ScanScreen(Self.input(items, now: "14:55", offline: true))
        #expect(s.eyebrow == "offline")
        #expect(s.slot == .line(symbol: "wifi.slash", text: "Scannen werkt gewoon zonder verbinding."))
        let a = try #require(s.accessory)
        #expect(a.title == "3 scans wachten op verbinding")
        #expect(a.meta == "Verstuurd zodra je online bent")
        let sheet = QueueSheet(Self.input(items, now: "14:55", offline: true))
        #expect(sheet.sections.map(\.title) == ["Wacht op verbinding · 3", "Verstuurd vandaag · 9"])
        #expect(sheet.sections[0].rows.allSatisfy { $0.meta == "Staat veilig op dit toestel" && $0.badge == .offline })
        #expect(sheet.footer == "Ze worden vanzelf verstuurd zodra je online bent. Verstuurde scans staan in Dossier.")
    }

    @Test func mislukt() throws {
        let items = Self.nine + [Self.item("11:05", .failed, failure: .noAnswer),
                                 Self.item("14:32", .pending, pages: 2, bytes: 1_400_000)]
        let s = ScanScreen(Self.input(items, now: "14:50"))
        #expect(s.slot == .line(symbol: "exclamationmark.circle", text: "11:05 niet verstuurd, staat veilig op dit toestel."))
        let a = try #require(s.accessory)
        #expect(a.title == "Niet verstuurd" && a.meta == "Geen antwoord" && a.action == .retry)
        #expect(a.actionTitle == "Opnieuw proberen")
        #expect(a.compactTitle == "1 mislukt")
    }

    /// "Wachtrij / veel": failed first, then on its way, then two of today's
    /// nine with "Toon alle 9".
    @Test func wachtrijVeel() {
        let items = Self.nine + [Self.item("11:05", .failed, failure: .noAnswer),
                                 Self.item("14:32", .pending, pages: 2, bytes: 1_400_000)]
        let sheet = QueueSheet(Self.input(items, now: "14:50"))
        #expect(sheet.sections.map(\.title) == ["Niet verstuurd · 1", "Wordt verstuurd · 1", "Verstuurd vandaag · 9"])
        let failed = sheet.sections[0].rows[0]
        #expect(failed.title == "Scan 11:05 · 1 pagina")
        #expect(failed.meta == "Geen antwoord")
        #expect(failed.detail == "Staat veilig op dit toestel. Tik Opnieuw proberen om het nog eens te versturen.")
        #expect(failed.canRetry && failed.canNote && failed.canRemove)
        #expect(sheet.sections[1].rows[0].title == "Scan 14:32 · 2 pagina's")
        #expect(sheet.sections[1].rows[0].meta == "1,4 MB")
        let sent = sheet.sections[2]
        #expect(sent.rows.map(\.title) == ["Scan 13:10 · 3 pagina's", "Scan 12:02 · 1 pagina"])
        #expect(sent.rows[0].meta == "Verstuurd 13:11 · in Dossier")
        #expect(sent.rows[0].documentId == "doc-13:10")
        #expect(sent.hidden == 7)
        #expect(QueueSheet(Self.input(items, now: "14:50"), showAllSent: true).sections[2].rows.count == 9)
        #expect(sheet.footer == "Verstuurde scans staan in Dossier. Deze lijst begint morgen weer leeg.")
    }

    @Test func logOpnieuwIn() throws {
        let items = Self.nine + [Self.item("14:32", .pending, pages: 2), Self.item("14:36", .pending)]
        let s = ScanScreen(Self.input(items, now: "14:50", signIn: true))
        #expect(s.slot == .line(symbol: "lock", text: "Je 2 scans staan veilig op dit toestel."))
        let a = try #require(s.accessory)
        #expect(a.title == "2 wachten" && a.meta == "Log opnieuw in om te versturen" && a.action == .signIn)
        let sheet = QueueSheet(Self.input(items, now: "14:50", signIn: true))
        #expect(sheet.sections.first?.kind == .signIn)
        #expect(sheet.sections.first?.title == "Wacht op inloggen · 2")
        #expect(sheet.footer == "Na het inloggen worden ze vanzelf verstuurd. Verstuurde scans staan in Dossier.")
    }

    /// Martin's rule: amber only for what waits on him. Nothing in this
    /// model can even name it — the views pick from ink and signal only.
    @Test func sizesAreDutch() {
        #expect(QueueSheet.size(1_400_000) == "1,4 MB")
        #expect(QueueSheet.size(600_000) == "600 kB")
    }
}

struct UploadQueueScanTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let pdf = Data("%PDF-1.4 test".utf8)

    @Test func enqueueRecordsPagesSizeAndEver() async throws {
        let dir = try scratchDir()
        let q = UploadQueue(dir: dir)
        #expect(await q.everEnqueued == false)
        let item = try await q.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan", pages: 2)
        #expect(item.pages == 2 && item.byteCount == pdf.count)
        #expect(await UploadQueue(dir: dir).everEnqueued)
    }

    @Test func failureKindAndDocumentId() async throws {
        let dir = try scratchDir()
        let q = UploadQueue(dir: dir)
        let a = try await q.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        await q.markFailure(a.id, error: .rejected(422), now: t0)
        #expect(await q.items().first?.failure == .refused)
        await q.retry(a.id)
        _ = await q.claimDue(now: t0)
        await q.markSent(a.id, documentId: "d1", now: t0)
        let sent = try #require(await q.items().first)
        #expect(sent.documentId == "d1" && sent.failure == nil)
    }

    @Test func noteIsKeptAndNeverOnASentItem() async throws {
        let dir = try scratchDir()
        let q = UploadQueue(dir: dir)
        let a = try await q.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        await q.setNote(a.id, "  Kwam aangetekend ")
        #expect(await UploadQueue(dir: dir).items().first?.note == "Kwam aangetekend")
        await q.setNote(a.id, "   ")
        #expect(await q.items().first?.note == nil)
        _ = await q.claimDue(now: t0)
        await q.markSent(a.id, now: t0)
        await q.setNote(a.id, "te laat")
        #expect(await q.items().first?.note == nil)
    }

    @Test func removeOnlyWhatIsNotUnderway() async throws {
        let dir = try scratchDir()
        let q = UploadQueue(dir: dir)
        let a = try await q.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        let b = try await q.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        _ = await q.claimDue(now: t0) // both sending
        #expect(await q.remove(a.id) == false)
        await q.markFailure(b.id, error: .rejected(400), now: t0)
        #expect(await q.remove(b.id))
        #expect(!FileManager.default.fileExists(atPath: q.fileURL(b).path()))
        #expect(await q.items().map(\.id) == [a.id])
    }

    /// The note rides along as a form field; no note, no field.
    @Test func noteTravelsInTheForm() async throws {
        let client = APIClient(base: URL(string: "https://example.test")!, session: .shared,
                               store: InMemorySessionStore(nil))
        var item = try await UploadQueue(dir: try scratchDir()).enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        let (_, without) = UploadRequest.build(item, file: pdf, client: client)
        #expect(!String(decoding: without, as: UTF8.self).contains("name=\"note\""))
        item.note = "Achterkant ontbreekt"
        let (_, with) = UploadRequest.build(item, file: pdf, client: client)
        #expect(String(decoding: with, as: UTF8.self).contains("name=\"note\"\r\n\r\nAchterkant ontbreekt"))
    }
}

struct ScanLinkTests {
    @Test func scanLinkOpensTheCamera() {
        #expect(DeepLink.parse("verder://scan") == .scan)
        #expect(DeepLink.parse("verder://scan/x") == DeepLink.none)
        #expect(DeepLink.scan.destination == LinkDestination(tab: .scan, stack: nil, opensCamera: true))
        #expect(QuickAction.link(forType: QuickAction.scanType) == .scan)
    }

    @Test func theQuickActionIsDeclared() throws {
        let items = try #require(Bundle.main.object(forInfoDictionaryKey: "UIApplicationShortcutItems") as? [[String: Any]])
        let scan = try #require(items.first { $0["UIApplicationShortcutItemType"] as? String == QuickAction.scanType })
        #expect(scan["UIApplicationShortcutItemTitle"] as? String == ScanLetterIntent.label)
        #expect(scan["UIApplicationShortcutItemIconSymbolName"] as? String == ScanLetterIntent.symbol,
                "the quick action wears the control's and the Action button's glyph")
    }

    /// Frame "Scan · snelstart": "Scan een brief", the page-with-lines
    /// viewfinder, and no Face ID — the intent runs in the app and opens Scan,
    /// which is never lock-gated.
    @Test func theShortcutsShareOneLabelAndGlyph() {
        #expect(ScanLetterIntent.label == "Scan een brief")
        #expect(ScanLetterIntent.symbol == "doc.text.viewfinder")
        #expect(String(localized: ScanLetterIntent.title) == ScanLetterIntent.label)
        #expect(ScanLetterIntent.openAppWhenRun)
        #expect(UIImage(systemName: ScanLetterIntent.symbol) != nil)
    }

    @Test func fixtureFlagsParse() throws {
        let l = try #require(try FixtureLaunch.parse(["V", "-fixtures", "calm", "-fixtures-queue", "failed-recent",
                                                      "-fixtures-camera", "denied", "-fixtures-scan", "note"]))
        #expect(l.queue == .failedRecent && l.camera == .denied && l.scanState == .note)
        #expect(FixtureLaunch.QueuePreset.allCases.map(\.rawValue)
                == ["first", "underway", "done", "offline", "failed", "failed-recent", "signin", "signin-recent"],
                "capture.sh's --queue grammar")
        #expect(throws: FixtureLaunch.ParseError.unknownValue("-fixtures-scan", "x")) {
            try FixtureLaunch.parse(["-fixtures", "calm", "-fixtures-scan", "x"])
        }
    }
}
