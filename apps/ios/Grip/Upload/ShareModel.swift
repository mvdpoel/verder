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
        /// A call recording, left for the app as an audio drop: it is
        /// transcribed in Grip, on the phone, and never uploaded from here.
        case handedToApp
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
        /// A call recording shared together with anything else.
        case audioAlone
        /// A call recording over `maxAudioBytes`.
        case tooLargeAudio
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
        enum Stage: Equatable {
            /// The photos are being combined into the one PDF: `current` is
            /// the photo under way, `total` the photos.
            case combining
            /// The files are being sent: `current` is the file under way.
            case sending
        }

        /// The file (or, combining, the photo) now under way, from 1.
        let current: Int
        let total: Int
        let finished: Int
        var stage: Stage = .sending

        /// `PDF maken · foto 2 van 3`, then `Versturen` (`· bestand 2 van 3` for several).
        var label: String {
            switch stage {
            case .combining: "\(Copy.combining) · foto \(current) van \(total)"
            case .sending: total == 1 ? Copy.sending : "\(Copy.sending) · bestand \(current) van \(total)"
            }
        }
        /// Half a file for the one under way, so the bar moves while it goes.
        var fraction: Double { total == 0 ? 0 : min(1, (Double(finished) + 0.5) / Double(total)) }
    }

    enum Copy {
        static let heading = "Naar Grip"
        static let cancel = "Annuleren"
        static let close = "Sluiten"
        static let send = "Versturen"
        static let keep = "Bewaar"
        static let done = "Klaar"
        static let retry = "Opnieuw proberen"
        static let sending = "Versturen"
        static let combining = "PDF maken"
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
        static let saveFailedOther = "Grip kon het niet op je iPhone bewaren. Probeer het opnieuw; "
            + "er is nog niets verstuurd."

        static let tooLargeTitle = "Te groot om mee te nemen"
        static let tooLargeBody = "Dat is meer dan Grip per bestand meeneemt. Scan de brief met Grip, "
            + "of deel een kleinere versie."
        static let linkTitle = "Hier zit geen bestand in"
        static let linkBody = "Je deelde een link. Grip bewaart alleen bestanden, geen links. Open de link, "
            + "bewaar de pagina als PDF en deel die met Grip."
        static let nothingTitle = "Niets om te bewaren"
        static let nothing = "Hier zit niets in dat Grip kan bewaren."
        static let unreadableTitle = "Niet te lezen"
        static let unreadable = "Grip kon hier niets uit lezen. Er is niets verstuurd."
        static let noGroupTitle = "Opslaan lukte niet"
        static let noGroup = "Grip kan hier niet bij zijn eigen map. Open de app en probeer het opnieuw."

        static let openToTranscribe = "Open Grip om het gesprek uit te schrijven."
        static let audioAloneTitle = "Eén opname tegelijk"
        static let audioAlone = "Deel een opname los, één tegelijk, zonder andere bestanden erbij."
        static let tooLargeAudio = "Deze opname is te groot voor Grip (max. 300 MB)."
        static let audioExplanation = "Grip schrijft het gesprek uit op je iPhone. De opname zelf gaat alleen mee "
            + "als je hem bewaart."

        static let signedOutHead = "Je bent niet ingelogd"
        static let signedOutBody = "Tik op Bewaar en open daarna Grip om in te loggen. Dan gaat het bestand "
            + "vanzelf naar je dossier."

        static let keptTitle = "Bewaard in Grip"
        static func deliveredTitle(_ n: Int) -> String {
            n == 1 ? "Staat in de wachtrij van Grip" : "Staan in de wachtrij van Grip"
        }
        static func deliveredBody(_ n: Int) -> String {
            (n == 1 ? "Hij komt" : "Ze komen") + " in je dossier onder Gedeeld. De voortgang zie je in Grip."
        }
        static func keptBody(_ n: Int) -> String {
            (n == 1 ? "Hij gaat" : "Ze gaan") + " mee zodra je Grip opent."
        }
        static let keptSignedOutBody = "Open Grip en log in; daarna gaat het bestand vanzelf naar je dossier."

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

    /// A call recording is transcribed ON the phone and only uploaded when
    /// Martin keeps it (where the voice route's 50 MB applies and the voice
    /// log says so), so it may be far larger than a document: an hour of
    /// 16-bit mono WAV at 44.1 kHz is ~320 MB… of which this takes most.
    /// Staged by copying, never read into the extension's memory.
    nonisolated static let maxAudioBytes = 300 * 1024 * 1024

    /// The size limit for one shared file of this name and type.
    nonisolated static func limit(fileName: String, mime: String) -> Int {
        IncomingDrop.isAudio(fileName: fileName, mime: mime) ? maxAudioBytes : maxFileBytes
    }

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
    /// The photos being combined into the one PDF, a page at a time after
    /// the share loaded; nil once the PDF is made (or there are no photos).
    /// Until then the photo PDF in `prepared` is a placeholder with no bytes:
    /// its pages and size are not stated, because they are not known yet.
    private(set) var combining: Combining?

    struct Combining: Equatable {
        /// The photo under way, from 1.
        let photo: Int
        let total: Int
        /// The staged photos the PDF is made of, in order: the photo stack
        /// draws these until the PDF's own pages exist.
        let photos: [URL]
    }
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
    /// How a staged photo becomes a page (`PhotoPage`).
    @ObservationIgnored let photoPage: (URL) -> UIImage?
    /// Awaited before each photo is combined (given its index): gives the run
    /// loop back so the screen moves and Annuleren answers between pages.
    @ObservationIgnored let pace: @MainActor (Int) async -> Void
    /// No session in the shared Keychain when the sheet opened: Versturen
    /// reads "Bewaar", writes the drops and makes no attempt.
    let signedOut: Bool
    /// The app that shared, when iOS says which; nil gives a neutral line.
    let sourceApp: String?

    init(groupDir: URL?, signedOut: Bool = false, sourceApp: String? = nil, sendBound: Duration = .seconds(20),
         now: @escaping () -> Date = { Date() }, writeDrop: @escaping DropWriter = ShareModel.writeDrop,
         photoPage: @escaping (URL) -> UIImage? = SharePreparation.photoPageLoader(_:),
         pace: @escaping @MainActor (Int) async -> Void = { _ in await Task.yield() },
         sender: @escaping Sender) {
        self.groupDir = groupDir
        self.signedOut = signedOut
        self.sourceApp = sourceApp
        self.sendBound = sendBound
        self.now = now
        self.writeDrop = writeDrop
        self.photoPage = photoPage
        self.pace = pace
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
    /// `maxItems` keeps the first ten. Photos are combined into their PDF
    /// afterwards, a page at a time (`combining`), so the screen is up and
    /// Annuleren answers while a ten-photo share is still being made.
    func loaded(_ inputs: [SharedInput]) {
        if handedOver < inputs.count { handedOver = inputs.count }
        let kept = Array(inputs.prefix(Self.maxItems))
        loadedCount = kept.count
        let capturedAt = now()
        let result = SharePreparation.prepare(kept, capturedAt: capturedAt, combinePhotos: false, photoPage: photoPage)
        combineGeneration += 1
        combining = nil
        let photos = result.pendingPhotos
        guard !photos.isEmpty else {
            apply(result)
            phase = restingPhase
            return
        }
        combining = Combining(photo: 1, total: photos.count, photos: photos)
        var placeholder = SharePreparation.combined((Data(), photos.count), into: result, photos: photos.count,
                                                    capturedAt: capturedAt)
        placeholder.photoPages = 0
        apply(placeholder)
        phase = restingPhase
        let generation = combineGeneration
        combineTask = Task { @MainActor in
            guard let builder = PDFAssembler.Builder() else {
                self.combined((Data(), 0), into: result, photos: photos.count, capturedAt: capturedAt)
                return
            }
            for (index, url) in photos.enumerated() {
                guard generation == self.combineGeneration else { return }
                self.combining = Combining(photo: index + 1, total: photos.count, photos: photos)
                if self.phase == .saving { self.progress = self.combiningProgress }
                await self.pace(index)
                guard generation == self.combineGeneration else { return }
                builder.add { self.photoPage(url) }
            }
            guard generation == self.combineGeneration else { return }
            self.combined(builder.finish(), into: result, photos: photos.count, capturedAt: capturedAt)
        }
    }

    @ObservationIgnored private var combineTask: Task<Void, Never>?
    @ObservationIgnored private var combineGeneration = 0

    /// Waits until the photo PDF is made (at once when there is none).
    func photosCombined() async {
        await combineTask?.value
    }

    private func combined(_ pdf: (data: Data, pageCount: Int), into base: SharePreparation.Result, photos: Int,
                          capturedAt: Date) {
        combining = nil
        apply(SharePreparation.combined(pdf, into: base, photos: photos, capturedAt: capturedAt))
        // Waiting for Versturen, the screen follows; once it runs, `commit` decides.
        if phase == .ready { phase = restingPhase }
    }

    private var combiningProgress: Progress? {
        combining.map { Progress(current: $0.photo, total: $0.total, finished: $0.photo - 1, stage: .combining) }
    }

    /// Takes `result` as what the share is (the phase is the caller's).
    private func apply(_ result: SharePreparation.Result) {
        // A file that grew past the limit while it was copied is left out too.
        var files: [PreparedShare] = []
        var tooLarge = result.tooLargeFiles
        for file in result.files {
            if file.byteCount > Self.limit(fileName: file.fileName, mime: file.mime) {
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
    }

    /// The phase the share's content calls for before Versturen.
    private var restingPhase: Phase {
        // A call recording goes to the voice log, alone: never in a share
        // with anything else, and never over its own (larger) limit.
        let audioIn = prepared.contains { IncomingDrop.isAudio(fileName: $0.fileName, mime: $0.mime) }
        let audioOut = tooLargeFiles.contains {
            IncomingDrop.isAudio(fileName: $0.fileName, mime: "application/octet-stream")
        }
        if audioIn || audioOut {
            if prepared.count + tooLargeFiles.count + leftOut + links.count > 1 || isCut { return .refused(.audioAlone) }
            if audioOut { return .refused(.tooLargeAudio) }
            return .ready
        }
        if !prepared.isEmpty { return .ready }
        if !tooLargeFiles.isEmpty { return .refused(.tooLarge) }
        if let link = links.first, leftOut == 0 { return .refused(.link(Self.displayLink(link))) }
        return .refused(loadedCount == 0 ? .nothing : .unreadable)
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
    var hasPhotoPDF: Bool { photoCount > 0 && !prepared.isEmpty }

    /// The photos in the photo PDF: while it is being made, the photos it is
    /// made of; after, the pages actually in it.
    private var photoCount: Int { combining?.total ?? photoPages }

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
            parts.append("PDF van \(Copy.photos(photoCount))")
        } else {
            parts.append(Self.kind(file.fileName))
        }
        if let pages = pageCounts.indices.contains(index) ? pageCounts[index] : nil {
            parts.append(Copy.pages(pages))
        }
        // A photo PDF still being made has no size yet; none is invented.
        if !(index == 0 && hasPhotoPDF && combining != nil) { parts.append(Self.size(file.byteCount)) }
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
        // No total while the photo PDF is being made: it would leave it out.
        guard combining == nil else { return kinds }
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
        return Copy.photos(photoCount)
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
            sentences.append("\(file.fileName) is te groot (\(size)max.\u{00A0}48\u{00A0}MB). Scan de brief met Grip, "
                             + "of deel later een kleinere versie.")
        } else if tooLargeFiles.count > 1 {
            sentences.append("\(tooLargeFiles.count) bestanden zijn te groot (max.\u{00A0}48\u{00A0}MB). Scan de brief "
                             + "met Grip, of deel later een kleinere versie.")
        }
        if leftOut == 1 { sentences.append("1 bestand kon niet worden gelezen.") }
        if leftOut > 1 { sentences.append("\(leftOut) bestanden konden niet worden gelezen.") }
        if links.count == 1 { sentences.append("De link gaat niet mee; Grip bewaart alleen bestanden.") }
        if links.count > 1 { sentences.append("De links gaan niet mee; Grip bewaart alleen bestanden.") }
        if isCut {
            let allPhotos = photosHandedOver == loadedCount
            let first = loadedCount + 1
            let range = first == handedOver ? "\(first)" : "\(first)–\(handedOver)"
            let rest = "Deel \(allPhotos ? "foto" : "bestand") \(range) daarna opnieuw."
            return Notice(head: "Dat zijn er \(handedOver); Grip neemt de eerste \(loadedCount) mee.",
                          body: ([rest] + sentences).joined(separator: " "))
        }
        guard !sentences.isEmpty else { return nil }
        let going = loadedCount - leftOut - tooLargeFiles.count - links.count
        return Notice(head: "Grip neemt er \(going) van de \(loadedCount) mee.", body: sentences.joined(separator: " "))
    }

    /// What happens next, matched to the share, so a share never seems to
    /// vanish: the downstream pipeline in one sentence.
    var explanation: Explanation? {
        switch phase {
        case .loading:
            return Explanation(label: Copy.explanationLabel, text: handedOver > 1
                ? "Komt in je dossier onder Gedeeld, elk bestand als eigen document."
                : "Komt in je dossier onder Gedeeld. Daarna zet Grip een suggestie voor naam en soort klaar in Voor jou.")
        case .ready, .saving: break
        default: return nil
        }
        let n = prepared.count
        guard n > 0 else { return nil }
        if isAudio { return Explanation(label: Copy.explanationLabel, text: Copy.audioExplanation) }
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
                ? "Komt in je dossier onder Gedeeld. Grip stelt daarna een naam voor in Voor jou."
                : "Komt in je dossier onder Gedeeld, eerst met deze tijdelijke naam. Grip stelt daarna een betere "
                    + "naam voor in Voor jou.")
        }
        if n == 1 {
            return Explanation(label: Copy.explanationLabel,
                               text: "Komt in je dossier onder Gedeeld. Daarna zet Grip een suggestie voor naam en "
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
        hasPhotoPDF && photoCount > 1 && !isCut && phase != .saving ? "Pagina's in de volgorde waarin je ze koos." : nil
    }

    var canSend: Bool { phase == .ready }

    /// The share is ONE call recording: it goes to the voice log, not the queue.
    var isAudio: Bool {
        prepared.count == 1 && IncomingDrop.isAudio(fileName: prepared[0].fileName, mime: prepared[0].mime)
    }

    /// Annuleren is offered only while it is TRUE: before Versturen, after a
    /// load or save that failed (nothing written), or after a refusal. From
    /// `.saving` on, the drops are written and the app WILL send them (each
    /// one a permanent `document.ingested`), so a cancel there would cancel
    /// nothing: it is shown dimmed, then the closing screen offers only Klaar.
    var canCancel: Bool {
        switch phase {
        case .loading, .loadFailed, .ready, .saveFailed, .refused: true
        case .saving, .done, .handedToApp: false
        }
    }

    var leading: Leading? {
        switch phase {
        case .loading, .loadFailed, .ready, .saveFailed: .cancel(enabled: true)
        case .saving: .cancel(enabled: false)
        case .refused: .close
        case .done, .handedToApp: nil
        }
    }

    var trailing: Trailing? {
        let label = signedOut ? Copy.keep : Copy.send
        return switch phase {
        case .loading: .send(label: label, enabled: false)
        case .ready: .send(label: label, enabled: true)
        case .saving: .progress
        case .done, .handedToApp: .done
        case .loadFailed, .saveFailed, .refused: nil
        }
    }

    /// The screen closes itself after an outcome only when there is nothing
    /// to read (no notice, not "log in"), and never for VoiceOver, Switch
    /// Control or accessibility text sizes, where Klaar is the way out.
    func closesByItself(voiceOver: Bool = false, switchControl: Bool = false, largeText: Bool = false) -> Bool {
        // A handed-over recording says what to do next: Martin reads it.
        if phase == .handedToApp { return false }
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
        if combining != nil, let task = combineTask {
            // Versturen during the photo PDF: it is finished first, and the
            // caption says which photo it is on.
            progress = combiningProgress
            await task.value
            guard !prepared.isEmpty else {
                // No photo could be made into a page, and nothing else came.
                progress = nil
                phase = restingPhase
                return
            }
        }
        if isAudio {
            // Never uploaded from here: Grip transcribes it on the phone,
            // and the audio leaves only if Martin keeps it.
            let file = prepared[0]
            do {
                switch file.content {
                case .data(let data):
                    try IncomingDrop.write(file: data, fileName: file.fileName, mime: file.mime, kind: .audio,
                                           capturedAt: now(), to: groupDir)
                case .file(let url):
                    try IncomingDrop.write(fileAt: url, fileName: file.fileName, mime: file.mime, kind: .audio,
                                           capturedAt: now(), to: groupDir)
                }
            } catch {
                phase = .saveFailed(Self.saveFailure(error))
                return
            }
            phase = .handedToApp
            return
        }
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
        if phase == .handedToApp {
            return Closing(title: Copy.keptTitle, body: Copy.openToTranscribe, reason: nil,
                           name: title, facts: detail, delivered: false)
        }
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
        case .refused(.audioAlone):
            Failure(symbol: "exclamationmark.circle", title: Copy.audioAloneTitle, body: Copy.audioAlone, retry: false)
        case .refused(.tooLargeAudio):
            Failure(symbol: nil, title: Copy.tooLargeTitle, body: Copy.tooLargeAudio, retry: false)
        default: nil
        }
    }
}
