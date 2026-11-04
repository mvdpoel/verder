import Foundation
import Observation
import PDFKit
import UIKit

/// The share extension's one screen, as state: what was shared, and what
/// happened when Martin tapped Versturen. Compiled into the app as well, so
/// the suite tests it; the view controller only loads the share sheet's items
/// and `ShareView` only draws this.
///
/// Versturen writes every prepared file as an `IncomingDrop` (that is the
/// moment it is safe: the app will queue it whatever happens next), then gives
/// the extension's own upload at most `sendBound` before reporting. A slow 4G
/// upload is cancelled, not waited for: the app's queue sends it, and the
/// clientId makes the overlap harmless.
///
/// Every item handed over is accounted for (the final "share · final"
/// frames): a share of more than ten takes the first ten and names the rest,
/// a file over 48 MB is left out BY NAME while the others go, a link is
/// answered as a link, a source that never delivers ends in a cause and
/// "Opnieuw proberen", and the closing screen says why a file waits.
@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable {
        case loading
        /// The source app did not hand the items over within `loadTimeout`.
        case loadFailed
        case ready
        case saving
        /// Writing the drops failed; everything written was taken back.
        case saveFailed(SaveFailure)
        case done(Outcome)
        case refused(Refusal)
    }

    enum SaveFailure: Equatable {
        case outOfSpace
        case other
    }

    enum Outcome: Equatable {
        /// The server confirmed every file before the bound.
        case delivered
        /// Safe in the App Group; the app's queue sends it, and this is why.
        case kept(KeptReason)
    }

    enum KeptReason: Equatable {
        case offline
        /// Over the extension's own upload limit (`ShareSender.foregroundLimit`).
        case largeFile(fileName: String, bytes: Int)
        /// No session in the shared Keychain, or the server answered 401.
        case signedOut
        /// Slow, or a failure with no clearer name.
        case unknown
    }

    enum Refusal: Equatable {
        case nothing
        case unreadable
        /// Every file was over `maxFileBytes`.
        case tooLarge
        case link(String)
        case noGroup
    }

    struct Notice: Equatable {
        let head: String
        let body: String
    }

    /// The "Waar het heen gaat" card.
    struct Explanation: Equatable {
        let label: String
        let text: String
    }

    /// One line of the list a share of several files shows.
    struct Row: Equatable, Identifiable {
        let id: Int
        let fileName: String
        let detail: [String]
        /// False for a file over `maxFileBytes`: drawn dimmed, never sent.
        let included: Bool
        /// The prepared file behind an included row (its thumbnail).
        let file: PreparedShare?
        /// A too-large PDF's first page, drawn while it was measured.
        let thumbnail: Data?
    }

    enum Leading: Equatable {
        case cancel(enabled: Bool)
        case close
    }

    enum Trailing: Equatable {
        case send(label: String, enabled: Bool)
        /// The attempt is under way: the capsule carries the upload symbol.
        case progress
        case done
    }

    struct Progress: Equatable {
        /// The file now being sent, from 1.
        let current: Int
        let total: Int
        let finished: Int

        var label: String { total == 1 ? Copy.sending : "\(Copy.sending) · bestand \(current) van \(total)" }
        /// Half a file for the one under way, so the bar moves while it goes.
        var fraction: Double { total == 0 ? 0 : min(1, (Double(finished) + 0.5) / Double(total)) }
    }

    enum Copy {
        static let heading = "Naar verder"
        static let cancel = "Annuleren"
        static let close = "Sluiten"
        static let send = "Versturen"
        static let keep = "Bewaar"
        static let done = "Klaar"
        static let retry = "Opnieuw proberen"
        static let sending = "Versturen"
        static let explanationLabel = "Waar het heen gaat"
        static let signedOutLabel = "Na het inloggen"
        static let linkLabel = "Wat je deelde · link"

        static let loadFailedTitle = "Bestand laden lukt niet"
        static func loadFailedBody(app: String?) -> String {
            "\(app ?? "De app") gaf het bestand niet binnen 10 seconden door. Probeer het opnieuw; lukt het dan "
                + "nog niet, bewaar het eerst in Bestanden en deel het van daaruit."
        }
        static let saveFailedTitle = "Opslaan lukte niet"
        static let outOfSpace = "Er is te weinig ruimte vrij op je iPhone. Maak ruimte en probeer het opnieuw; "
            + "er is nog niets verstuurd."
        static let saveFailedOther = "verder kon het niet op je iPhone bewaren. Probeer het opnieuw; "
            + "er is nog niets verstuurd."

        static let tooLargeTitle = "Te groot om mee te nemen"
        static let tooLargeBody = "Dat is meer dan verder per bestand meeneemt. Scan de brief met verder, "
            + "of deel een kleinere versie."
        static let linkTitle = "Hier zit geen bestand in"
        static let linkBody = "Je deelde een link. verder bewaart alleen bestanden, geen links. Open de link, "
            + "bewaar de pagina als PDF en deel die met verder."
        static let nothingTitle = "Niets om te bewaren"
        static let nothing = "Hier zit niets in dat verder kan bewaren."
        static let unreadableTitle = "Niet te lezen"
        static let unreadable = "verder kon hier niets uit lezen. Er is niets verstuurd."
        static let noGroupTitle = "Opslaan lukte niet"
        static let noGroup = "verder kan hier niet bij zijn eigen map. Open de app en probeer het opnieuw."

        static let signedOutHead = "Je bent niet ingelogd"
        static let signedOutBody = "Tik op Bewaar en open daarna verder om in te loggen. Dan gaat het bestand "
            + "vanzelf naar je dossier."

        static let keptTitle = "Bewaard in verder"
        static func deliveredTitle(_ n: Int) -> String {
            n == 1 ? "Staat in de wachtrij van verder" : "Staan in de wachtrij van verder"
        }
        static func deliveredBody(_ n: Int) -> String {
            (n == 1 ? "Hij komt" : "Ze komen") + " in je dossier onder Gedeeld. De voortgang zie je in verder."
        }
        static func keptBody(_ n: Int) -> String {
            (n == 1 ? "Hij gaat" : "Ze gaan") + " mee zodra je verder opent."
        }
        static let keptSignedOutBody = "Open verder en log in; daarna gaat het bestand vanzelf naar je dossier."

        /// `2 pagina's`, `1 pagina`.
        static func pages(_ n: Int) -> String { n == 1 ? "1\u{00A0}pagina" : "\(n)\u{00A0}pagina's" }
        static func photos(_ n: Int) -> String { n == 1 ? "1\u{00A0}foto" : "\(n)\u{00A0}foto's" }
    }

    /// The most items one share takes. A larger share keeps the first ten and
    /// names the rest ("Deel foto 11–14 daarna opnieuw"), never cut short in
    /// silence. The activation rule counts files and images under separate
    /// keys, so a mixed share can hand over more.
    nonisolated static let maxItems = 10

    /// Under the server's 50 MB (`MAX_UPLOAD_BYTES`), leaving room for the
    /// multipart envelope. NOT a memory figure: an extension is killed around
    /// 120 MB, so a shared file is measured before it is read
    /// (`ShareStaging`), copied rather than buffered into its drop, and only a
    /// drop under `ShareSender.foregroundLimit` is sent from the extension.
    nonisolated static let maxFileBytes = 48 * 1024 * 1024

    /// How long a source app may take to hand its items over.
    nonisolated static let loadTimeout: Duration = .seconds(10)

    /// How long an outcome stays up before the extension closes itself.
    nonisolated static let autoCloseDelay: Duration = .seconds(3)

    private(set) var phase: Phase = .loading
    private(set) var prepared: [PreparedShare] = []
    /// How many pages are IN the one photo PDF, for the detail line.
    private(set) var photoPages = 0
    /// Items handed over (all of them, more than `maxItems` included), and
    /// how many of the loaded ones are not in `prepared`.
    private(set) var handedOver = 0
    private(set) var leftOut = 0
    private(set) var tooLargeFiles: [SharePreparation.TooLargeFile] = []
    private(set) var links: [String] = []
    private(set) var progress: Progress?
    /// Pages of each prepared PDF, read lazily by PDFKit (nil for other files).
    private var pageCounts: [Int?] = []
    private var loadedCount = 0
    private var photosHandedOver = 0

    typealias Sender = @Sendable (UUID, URL) async -> ShareSendResult
    typealias DropWriter = (PreparedShare, Date, URL) throws -> UUID

    @ObservationIgnored let groupDir: URL?
    @ObservationIgnored let sender: Sender
    @ObservationIgnored let sendBound: Duration
    @ObservationIgnored let now: () -> Date
    @ObservationIgnored let writeDrop: DropWriter
    /// No session in the shared Keychain when the sheet opened: Versturen
    /// reads "Bewaar", writes the drops and makes no attempt.
    let signedOut: Bool
    /// The app that shared, when iOS says which; nil gives a neutral line.
    let sourceApp: String?

    init(groupDir: URL?, signedOut: Bool = false, sourceApp: String? = nil, sendBound: Duration = .seconds(20),
         now: @escaping () -> Date = { Date() }, writeDrop: @escaping DropWriter = ShareModel.writeDrop,
         sender: @escaping Sender) {
        self.groupDir = groupDir
        self.signedOut = signedOut
        self.sourceApp = sourceApp
        self.sendBound = sendBound
        self.now = now
        self.writeDrop = writeDrop
        self.sender = sender
    }

    nonisolated static func writeDrop(_ file: PreparedShare, capturedAt: Date, to groupDir: URL) throws -> UUID {
        switch file.content {
        case .data(let data):
            try IncomingDrop.write(file: data, fileName: file.fileName, mime: file.mime,
                                   capturedAt: capturedAt, to: groupDir)
        case .file(let url):
            try IncomingDrop.write(fileAt: url, fileName: file.fileName, mime: file.mime,
                                   capturedAt: capturedAt, to: groupDir)
        }
    }

    // MARK: - Loading

    /// How many items the share sheet handed over, before any is loaded, and
    /// how many of them to load: the first `maxItems`.
    @discardableResult
    func handedOver(count: Int) -> Int {
        handedOver = count
        return min(count, Self.maxItems)
    }

    @ObservationIgnored private var loadWork: (@MainActor () async -> [SharedInput])?
    @ObservationIgnored private var loadGeneration = 0

    /// Runs `work` (the view controller's `NSItemProvider` loads) with a
    /// bound: a source that has not answered within `timeout` ends in
    /// `.loadFailed` with a cause and "Opnieuw proberen", never an endless
    /// "Even laden…". A late answer from an abandoned attempt is ignored.
    func load(timeout: Duration = ShareModel.loadTimeout, _ work: @escaping @MainActor () async -> [SharedInput]) {
        loadWork = work
        start(timeout: timeout)
    }

    /// "Opnieuw proberen" after a load that timed out: the same sources again.
    func retryLoad(timeout: Duration = ShareModel.loadTimeout) {
        guard phase == .loadFailed, loadWork != nil else { return }
        phase = .loading
        start(timeout: timeout)
    }

    private func start(timeout: Duration) {
        guard let work = loadWork else { return }
        loadGeneration += 1
        let generation = loadGeneration
        Task { @MainActor in
            let inputs = await work()
            guard generation == self.loadGeneration, self.phase == .loading else { return }
            self.loaded(inputs)
        }
        Task { @MainActor in
            try? await Task.sleep(for: timeout)
            guard generation == self.loadGeneration, self.phase == .loading else { return }
            self.loadGeneration += 1
            self.phase = .loadFailed
        }
    }

    /// The share sheet's items, loaded: one input per item loaded, an item
    /// that could not be read included as `.unreadable`. More than
    /// `maxItems` keeps the first ten.
    func loaded(_ inputs: [SharedInput]) {
        if handedOver < inputs.count { handedOver = inputs.count }
        let kept = Array(inputs.prefix(Self.maxItems))
        loadedCount = kept.count
        let result = SharePreparation.prepare(kept, capturedAt: now())
        // A file that grew past the limit while it was copied is left out too.
        var files: [PreparedShare] = []
        var tooLarge = result.tooLargeFiles
        for file in result.files {
            if file.byteCount > Self.maxFileBytes {
                tooLarge.append(.init(fileName: file.fileName, bytes: file.byteCount, thumbnail: nil,
                                      position: files.count))
            } else {
                files.append(file)
            }
        }
        prepared = files
        photoPages = result.photoPages
        leftOut = result.leftOut
        tooLargeFiles = tooLarge
        links = result.links
        photosHandedOver = result.photosHandedOver
        pageCounts = files.enumerated().map { index, file in
            if index == 0, result.photoPages > 0 { return result.photoPages }
            return Self.pageCount(file)
        }
        if !prepared.isEmpty {
            phase = .ready
        } else if !tooLargeFiles.isEmpty {
            phase = .refused(.tooLarge)
        } else if let link = links.first, leftOut == 0 {
            phase = .refused(.link(Self.displayLink(link)))
        } else {
            phase = .refused(kept.isEmpty ? .nothing : .unreadable)
        }
    }

    static func pageCount(_ file: PreparedShare) -> Int? {
        guard file.mime == "application/pdf" else { return nil }
        let document: PDFDocument? = switch file.content {
        case .data(let data): PDFDocument(data: data)
        case .file(let url): PDFDocument(url: url)
        }
        guard let count = document?.pageCount, count > 0 else { return nil }
        return count
    }

    /// `https://www.westerlaan.example/bijstand/` → `westerlaan.example/bijstand`.
    nonisolated static func displayLink(_ link: String) -> String {
        var s = link
        for prefix in ["https://", "http://"] where s.lowercased().hasPrefix(prefix) { s.removeFirst(prefix.count) }
        if s.lowercased().hasPrefix("www.") { s.removeFirst(4) }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    // MARK: - What the screen says

    /// The photo PDF, when the share made one: always the first file.
    var hasPhotoPDF: Bool { photoPages > 0 && !prepared.isEmpty }

    var title: String {
        prepared.count == 1 ? prepared[0].fileName : "\(prepared.count) bestanden"
    }

    /// The facts of one prepared file, each its own part so large text can
    /// stack them: `PDF · 2 pagina's · 312 kB`, `PDF van 3 foto's · 3 pagina's · 1,8 MB`.
    func detail(of index: Int) -> [String] {
        guard prepared.indices.contains(index) else { return [] }
        let file = prepared[index]
        var parts: [String] = []
        if index == 0, hasPhotoPDF {
            parts.append("PDF van \(Copy.photos(photoPages))")
        } else {
            parts.append(Self.kind(file.fileName))
        }
        if let pages = pageCounts.indices.contains(index) ? pageCounts[index] : nil {
            parts.append(Copy.pages(pages))
        }
        parts.append(Self.size(file.byteCount))
        return parts
    }

    /// The detail under the title: one file's own facts, or for several the
    /// kinds and the total, `PDF · samen 1,1 MB`.
    var detail: [String] {
        if prepared.count == 1 { return detail(of: 0) }
        var kinds: [String] = []
        for (index, file) in prepared.enumerated() {
            let kind = index == 0 && hasPhotoPDF ? "PDF" : Self.kind(file.fileName)
            if !kinds.contains(kind) { kinds.append(kind) }
        }
        return kinds + ["samen \(Self.size(prepared.reduce(0) { $0 + $1.byteCount }))"]
    }

    /// A file name as the screen sets it: a day and its month never part
    /// across a line ("30 okt.pdf"), so a no-break space joins them.
    nonisolated static func displayName(_ fileName: String) -> String {
        fileName.replacing(/(\d) (jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec)(?![A-Za-z])/) { match in
            "\(match.output.1)\u{00A0}\(match.output.2)"
        }
    }

    /// `PDF`, `XLSX`, or `Bestand` for a name without an extension.
    nonisolated static func kind(_ fileName: String) -> String {
        let ext = (fileName as NSString).pathExtension.uppercased()
        return ext.isEmpty ? "Bestand" : ext
    }

    /// `312 kB`, `1,8 MB`, with a no-break space so the number never leaves its unit.
    nonisolated static func size(_ bytes: Int) -> String {
        bytes.formatted(.byteCount(style: .file).locale(Locale(identifier: "nl_NL")))
            .replacingOccurrences(of: " ", with: "\u{00A0}")
    }

    /// One row per file, in the order they were shared, a file left out on
    /// its size included (dimmed, with why). Empty for a single file.
    var rows: [Row] {
        let total = prepared.count + tooLargeFiles.count
        guard total > 1 else { return [] }
        var result: [Row] = []
        var large = tooLargeFiles.makeIterator()
        var nextLarge = large.next()
        var fileIndex = 0
        while result.count < total {
            if let l = nextLarge, l.position <= fileIndex || fileIndex >= prepared.count {
                let size = l.bytes.map { "\(Self.size($0)), max.\u{00A0}48\u{00A0}MB" } ?? "max.\u{00A0}48\u{00A0}MB"
                result.append(Row(id: result.count, fileName: l.fileName, detail: ["Gaat niet mee", size],
                                  included: false, file: nil, thumbnail: l.thumbnail))
                nextLarge = large.next()
            } else {
                result.append(Row(id: result.count, fileName: prepared[fileIndex].fileName, detail: detail(of: fileIndex),
                                  included: true, file: prepared[fileIndex], thumbnail: nil))
                fileIndex += 1
            }
        }
        return result
    }

    /// The badge on the photo stack: `3 FOTO'S`, `FOTO 1–10 VAN 14`
    /// (the view sets its case).
    var photoBadge: String? {
        guard hasPhotoPDF else { return nil }
        if isCut { return "foto 1–\(loadedCount) van \(handedOver)" }
        return Copy.photos(photoPages)
    }

    /// More was handed over than `maxItems`.
    var isCut: Bool { handedOver > loadedCount && loadedCount > 0 }

    /// What did not go, said before Versturen and kept on the closing
    /// screen's absence of a self-close: never a partial share that reads as
    /// a whole one.
    var notice: Notice? {
        if signedOut, phase == .ready { return Notice(head: Copy.signedOutHead, body: Copy.signedOutBody) }
        guard !prepared.isEmpty else { return nil }
        var sentences: [String] = []
        if tooLargeFiles.count == 1, let file = tooLargeFiles.first {
            let size = file.bytes.map { "\(Self.size($0)), " } ?? ""
            sentences.append("\(file.fileName) is te groot (\(size)max.\u{00A0}48\u{00A0}MB). Scan de brief met verder, "
                             + "of deel later een kleinere versie.")
        } else if tooLargeFiles.count > 1 {
            sentences.append("\(tooLargeFiles.count) bestanden zijn te groot (max.\u{00A0}48\u{00A0}MB). Scan de brief "
                             + "met verder, of deel later een kleinere versie.")
        }
        if leftOut == 1 { sentences.append("1 bestand kon niet worden gelezen.") }
        if leftOut > 1 { sentences.append("\(leftOut) bestanden konden niet worden gelezen.") }
        if links.count == 1 { sentences.append("De link gaat niet mee; verder bewaart alleen bestanden.") }
        if links.count > 1 { sentences.append("De links gaan niet mee; verder bewaart alleen bestanden.") }
        if isCut {
            let allPhotos = photosHandedOver == loadedCount
            let first = loadedCount + 1
            let range = first == handedOver ? "\(first)" : "\(first)–\(handedOver)"
            let rest = "Deel \(allPhotos ? "foto" : "bestand") \(range) daarna opnieuw."
            return Notice(head: "Dat zijn er \(handedOver); verder neemt de eerste \(loadedCount) mee.",
                          body: ([rest] + sentences).joined(separator: " "))
        }
        guard !sentences.isEmpty else { return nil }
        let going = loadedCount - leftOut - tooLargeFiles.count - links.count
        return Notice(head: "verder neemt er \(going) van de \(loadedCount) mee.", body: sentences.joined(separator: " "))
    }

    /// What happens next, matched to the share, so a share never seems to
    /// vanish: the downstream pipeline in one sentence.
    var explanation: Explanation? {
        switch phase {
        case .loading:
            return Explanation(label: Copy.explanationLabel, text: handedOver > 1
                ? "Komt in je dossier onder Gedeeld, elk bestand als eigen document."
                : "Komt in je dossier onder Gedeeld. Daarna zet verder een suggestie voor naam en soort klaar in Voor jou.")
        case .ready, .saving: break
        default: return nil
        }
        let n = prepared.count
        guard n > 0 else { return nil }
        if signedOut {
            return Explanation(label: Copy.signedOutLabel, text: n == 1
                ? "Komt het in je dossier onder Gedeeld."
                : "Komen ze in je dossier onder Gedeeld, elk als eigen document.")
        }
        let partial = !tooLargeFiles.isEmpty || leftOut > 0 || !links.isEmpty
        if partial {
            return Explanation(label: Copy.explanationLabel, text: n == 1
                ? "Het bestand dat meegaat komt in je dossier onder Gedeeld."
                : "De \(Self.number(n)) die meegaan komen in je dossier onder Gedeeld.")
        }
        if n == 1, hasPhotoPDF {
            return Explanation(label: Copy.explanationLabel, text: isCut
                ? "Komt in je dossier onder Gedeeld. verder stelt daarna een naam voor in Voor jou."
                : "Komt in je dossier onder Gedeeld, eerst met deze tijdelijke naam. verder stelt daarna een betere "
                    + "naam voor in Voor jou.")
        }
        if n == 1 {
            return Explanation(label: Copy.explanationLabel,
                               text: "Komt in je dossier onder Gedeeld. Daarna zet verder een suggestie voor naam en "
                                   + "soort klaar in Voor jou.")
        }
        let all = n == 2 ? "allebei" : "alle \(Self.number(n))"
        return Explanation(label: Copy.explanationLabel,
                           text: "Komen \(all) in je dossier onder Gedeeld, elk als eigen document. Daarna staan de "
                               + "suggesties in Voor jou.")
    }

    nonisolated static func number(_ n: Int) -> String {
        let words = ["nul", "een", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen", "tien"]
        return words.indices.contains(n) ? words[n] : "\(n)"
    }

    /// "Pagina's in de volgorde waarin je ze koos." under a photo PDF of
    /// more than one page (not when the share was cut: the notice speaks).
    var orderNote: String? {
        hasPhotoPDF && photoPages > 1 && !isCut && phase != .saving ? "Pagina's in de volgorde waarin je ze koos." : nil
    }

    var canSend: Bool { phase == .ready }

    /// Annuleren is offered only while it is TRUE: before Versturen, after a
    /// load or save that failed (nothing written), or after a refusal. From
    /// `.saving` on, the drops are written and the app WILL send them (each
    /// one a permanent `document.ingested`), so a cancel there would cancel
    /// nothing: it is shown dimmed, then the closing screen offers only Klaar.
    var canCancel: Bool {
        switch phase {
        case .loading, .loadFailed, .ready, .saveFailed, .refused: true
        case .saving, .done: false
        }
    }

    var leading: Leading? {
        switch phase {
        case .loading, .loadFailed, .ready, .saveFailed: .cancel(enabled: true)
        case .saving: .cancel(enabled: false)
        case .refused: .close
        case .done: nil
        }
    }

    var trailing: Trailing? {
        let label = signedOut ? Copy.keep : Copy.send
        return switch phase {
        case .loading: .send(label: label, enabled: false)
        case .ready: .send(label: label, enabled: true)
        case .saving: .progress
        case .done: .done
        case .loadFailed, .saveFailed, .refused: nil
        }
    }

    /// The screen closes itself after an outcome only when there is nothing
    /// to read (no notice, not "log in"), and never for VoiceOver, Switch
    /// Control or accessibility text sizes, where Klaar is the way out.
    func closesByItself(voiceOver: Bool = false, switchControl: Bool = false, largeText: Bool = false) -> Bool {
        guard case .done(let outcome) = phase else { return notice == nil && !signedOut }
        guard notice == nil, outcome != .kept(.signedOut) else { return false }
        return !voiceOver && !switchControl && !largeText
    }

    // MARK: - Versturen

    /// Versturen (or Bewaar, signed out), and "Opnieuw proberen" after a save that failed.
    func commit() async {
        switch phase {
        case .ready, .saveFailed: break
        default: return
        }
        guard let groupDir else { phase = .refused(.noGroup); return }
        phase = .saving
        progress = Progress(current: 1, total: prepared.count, finished: 0)
        var ids: [UUID] = []
        do {
            for file in prepared {
                ids.append(try writeDrop(file, now(), groupDir))
            }
        } catch {
            // Nothing has been sent yet, so the drops already written are
            // taken back: "Opslaan lukte niet" must mean that NOTHING of this
            // share will reach the dossier, and Opnieuw proberen starts clean.
            for id in ids { IncomingDrop.remove(id, groupDir: groupDir) }
            progress = nil
            phase = .saveFailed(Self.saveFailure(error))
            return
        }
        if signedOut {
            progress = nil
            phase = .done(.kept(.signedOut))
            return
        }
        results = [:]
        let bound = sendBound
        // Whichever comes first: every file answered, or the bound. A send
        // still running at the bound is cancelled and its late answer ignored.
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let once = Once(c)
            let work = Task { @MainActor in
                await self.sendAll(ids, groupDir: groupDir)
                once.resume()
            }
            Task { @MainActor in
                try? await Task.sleep(for: bound)
                work.cancel()
                once.resume()
            }
        }
        progress = nil
        phase = .done(Self.outcome(ids.map { results[$0] }, files: prepared))
    }

    private func sendAll(_ ids: [UUID], groupDir: URL) async {
        for (index, id) in ids.enumerated() {
            guard !Task.isCancelled else { return }
            progress = Progress(current: index + 1, total: ids.count, finished: index)
            let result = await sender(id, groupDir)
            // A send that returns after the bound did not beat it.
            guard !Task.isCancelled else { return }
            results[id] = result
        }
    }

    @MainActor private final class Once {
        private var continuation: CheckedContinuation<Void, Never>?
        init(_ c: CheckedContinuation<Void, Never>) { continuation = c }
        func resume() {
            continuation?.resume()
            continuation = nil
        }
    }

    @ObservationIgnored private var results: [UUID: ShareSendResult] = [:]

    /// The outcome of the attempt: delivered only when every file was; else
    /// the reason that explains the most (no session, no network, too large
    /// for the extension's own upload, or nothing clearer). `nil` is a file
    /// the bound cut off.
    nonisolated static func outcome(_ results: [ShareSendResult?], files: [PreparedShare]) -> Outcome {
        if !results.isEmpty, results.allSatisfy({ $0 == .sent }) { return .delivered }
        if results.contains(.unauthorized) { return .kept(.signedOut) }
        if results.contains(.offline) { return .kept(.offline) }
        let large = zip(results, files).filter { $0.0 == .tooLargeForExtension }.map(\.1)
        if let biggest = large.max(by: { $0.byteCount < $1.byteCount }) {
            return .kept(.largeFile(fileName: biggest.fileName, bytes: biggest.byteCount))
        }
        return .kept(.unknown)
    }

    /// Out of space (ENOSPC, NSFileWriteOutOfSpaceError, also underneath a
    /// wrapping error) is named; anything else is a plain failure.
    nonisolated static func saveFailure(_ error: any Error) -> SaveFailure {
        var current: NSError? = error as NSError
        while let e = current {
            if e.domain == NSCocoaErrorDomain && e.code == NSFileWriteOutOfSpaceError { return .outOfSpace }
            if e.domain == NSPOSIXErrorDomain && e.code == Int(ENOSPC) { return .outOfSpace }
            current = e.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return .other
    }

    // MARK: - The closing screen

    struct Closing: Equatable {
        let title: String
        let body: String
        /// `offline · in wachtrij`; nil when the outcome needs no reason.
        let reason: String?
        /// The share, as the readout under it: the name, then its facts.
        let name: String
        let facts: [String]
        let delivered: Bool
    }

    var closing: Closing? {
        guard case .done(let outcome) = phase else { return nil }
        let n = prepared.count
        switch outcome {
        case .delivered:
            return Closing(title: Copy.deliveredTitle(n), body: Copy.deliveredBody(n), reason: nil,
                           name: title, facts: detail, delivered: true)
        case .kept(.signedOut):
            return Closing(title: Copy.keptTitle, body: Copy.keptSignedOutBody, reason: nil,
                           name: title, facts: detail, delivered: false)
        case .kept(.offline):
            return Closing(title: Copy.keptTitle, body: Copy.keptBody(n), reason: "offline · in wachtrij",
                           name: title, facts: [], delivered: false)
        case .kept(.largeFile(let fileName, let bytes)):
            return Closing(title: Copy.keptTitle, body: Copy.keptBody(n), reason: "groot bestand · in wachtrij",
                           name: fileName, facts: [Self.size(bytes)], delivered: false)
        case .kept(.unknown):
            return Closing(title: Copy.keptTitle, body: Copy.keptBody(n), reason: "in wachtrij",
                           name: title, facts: [], delivered: false)
        }
    }

    /// The failure screens (load, save, refusals): a symbol, a title, a cause.
    struct Failure: Equatable {
        let symbol: String?
        let title: String
        let body: String
        let retry: Bool
    }

    var failure: Failure? {
        switch phase {
        case .loadFailed:
            Failure(symbol: "exclamationmark.circle", title: Copy.loadFailedTitle,
                    body: Copy.loadFailedBody(app: sourceApp), retry: true)
        case .saveFailed(let why):
            Failure(symbol: "exclamationmark.circle", title: Copy.saveFailedTitle,
                    body: why == .outOfSpace ? Copy.outOfSpace : Copy.saveFailedOther, retry: true)
        case .refused(.tooLarge):
            Failure(symbol: nil, title: Copy.tooLargeTitle, body: Copy.tooLargeBody, retry: false)
        case .refused(.link):
            Failure(symbol: "link", title: Copy.linkTitle, body: Copy.linkBody, retry: false)
        case .refused(.nothing):
            Failure(symbol: "exclamationmark.circle", title: Copy.nothingTitle, body: Copy.nothing, retry: false)
        case .refused(.unreadable):
            Failure(symbol: "exclamationmark.circle", title: Copy.unreadableTitle, body: Copy.unreadable, retry: false)
        case .refused(.noGroup):
            Failure(symbol: "exclamationmark.circle", title: Copy.noGroupTitle, body: Copy.noGroup, retry: false)
        default: nil
        }
    }
}
