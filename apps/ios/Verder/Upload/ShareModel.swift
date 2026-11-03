import Foundation
import Observation
import UIKit

/// The share extension's one screen, as state: what was shared, and what
/// happened when Martin tapped Versturen. Compiled into the app as well, so
/// the suite tests it; the view controller only loads the share sheet's items
/// and draws this.
///
/// Versturen writes every prepared file as an `IncomingDrop` (that is the
/// moment it is safe: the app will queue it whatever happens next), then gives
/// the extension's own upload at most `sendBound` before reporting. A slow 4G
/// upload is cancelled, not waited for: the app's queue sends it, and the
/// clientId makes the overlap harmless.
@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable {
        case loading
        case ready
        case saving
        /// `delivered`: the server confirmed every file before the bound.
        case done(delivered: Bool)
        /// A call recording, left for the app as an audio drop: it is
        /// transcribed in verder, on the phone, and never uploaded from here.
        case handedToApp
        case refused(String)
    }

    enum Copy {
        static let heading = "Naar verder"
        static let cancel = "Annuleren"
        static let send = "Versturen"
        static let loading = "Even laden…"
        static let saving = "Wordt verstuurd…"
        static let delivered = "Staat in je dossier."
        static let queued = "Bewaard. Het gaat mee zodra je verder opent."
        static let nothing = "Hier zit niets in dat verder kan bewaren."
        static let tooLarge = "Dit is te groot voor verder (max. 48 MB per bestand)."
        static let saveFailed = "Dit kon niet worden bewaard. Probeer het opnieuw."
        static let noGroup = "verder kan hier niet bij zijn eigen map. Open de app en probeer het opnieuw."
        static let unreadable = "verder kon hier niets uit lezen. Er is niets verstuurd."
        static let close = "Sluiten"
        static let openToTranscribe = "Open verder om het gesprek uit te schrijven."
        static let audioAlone = "Deel een opname los, één tegelijk, zonder andere bestanden erbij."
        static let tooLargeAudio = "Deze opname is te groot voor verder (max. 300 MB)."
        /// `Dat zijn er 12. verder neemt er maximaal 10 tegelijk mee; deel ze in delen.`
        static func tooMany(_ count: Int) -> String {
            "Dat zijn er \(count). verder neemt er maximaal \(ShareModel.maxItems) tegelijk mee; deel ze in delen."
        }
        /// `1 van 3 kon niet worden meegenomen.`, `2 van 12 konden …`
        static func leftOut(_ missing: Int, of total: Int) -> String {
            "\(missing) van \(total) \(missing == 1 ? "kon" : "konden") niet worden meegenomen."
        }
    }

    /// The most items one share takes. The activation rule counts files and
    /// images under separate keys, so a mixed share can hand over more; above
    /// this the share is refused with a message, never cut short in silence.
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

    private(set) var phase: Phase = .loading
    private(set) var prepared: [PreparedShare] = []
    /// How many pages are IN the one photo PDF, for the detail line.
    private(set) var photoPages = 0
    /// Items handed over, and how many of them are not in `prepared`.
    private(set) var handedOver = 0
    private(set) var leftOut = 0

    typealias Sender = @Sendable ([UUID], URL) async -> [UUID]

    @ObservationIgnored let groupDir: URL?
    @ObservationIgnored let sender: Sender
    @ObservationIgnored let sendBound: Duration
    @ObservationIgnored let now: () -> Date

    init(groupDir: URL?, sendBound: Duration = .seconds(20), now: @escaping () -> Date = { Date() },
         sender: @escaping Sender) {
        self.groupDir = groupDir
        self.sendBound = sendBound
        self.now = now
        self.sender = sender
    }

    /// How many items the share sheet handed over, before any is loaded.
    /// False (and refused) above `maxItems`, so nothing is loaded for a share
    /// that will not go.
    @discardableResult
    func handedOver(count: Int) -> Bool {
        handedOver = count
        guard count <= Self.maxItems else {
            phase = .refused(Copy.tooMany(count))
            return false
        }
        return true
    }

    /// The share sheet's items, loaded: one input per item handed over, an
    /// item that could not be read included as `.unreadable`.
    func loaded(_ inputs: [SharedInput]) {
        guard handedOver(count: inputs.count) else { return }
        let result = SharePreparation.prepare(inputs, capturedAt: now())
        prepared = result.files
        photoPages = result.photoPages
        leftOut = result.leftOut
        let audio = prepared.filter { IncomingDrop.isAudio(fileName: $0.fileName, mime: $0.mime) }
        if !audio.isEmpty, prepared.count > 1 || result.tooLarge > 0 || result.leftOut > 0 {
            phase = .refused(Copy.audioAlone)
        } else if let one = audio.first, one.byteCount > Self.maxAudioBytes {
            phase = .refused(Copy.tooLargeAudio)
        } else if audio.isEmpty,
                  result.tooLarge > 0 || prepared.contains(where: { $0.byteCount > Self.maxFileBytes }) {
            phase = .refused(Copy.tooLarge)
        } else if prepared.isEmpty {
            phase = .refused(inputs.isEmpty ? Copy.nothing : Copy.unreadable)
        } else {
            phase = .ready
        }
    }

    var title: String {
        prepared.count == 1 ? prepared[0].fileName : "\(prepared.count) bestanden"
    }

    /// `2 foto's als één PDF · 1,2 MB`, `PDF · 340 kB`.
    var detail: String {
        var parts: [String] = []
        if photoPages > 0 { parts.append(photoPages == 1 ? "1 foto als PDF" : "\(photoPages) foto's als één PDF") }
        let others = prepared.count - (photoPages > 0 ? 1 : 0)
        if others > 0, photoPages > 0 { parts.append(others == 1 ? "1 bestand" : "\(others) bestanden") }
        if photoPages == 0, prepared.count == 1 {
            parts.append(((prepared[0].fileName as NSString).pathExtension.uppercased()).ifEmpty("Bestand"))
        }
        let bytes = prepared.reduce(0) { $0 + $1.byteCount }
        parts.append(bytes.formatted(.byteCount(style: .file).locale(Locale(identifier: "nl_NL"))))
        return parts.joined(separator: " · ")
    }

    var canSend: Bool { phase == .ready }

    /// The share is ONE call recording: it goes to the voice log, not the queue.
    var isAudio: Bool {
        prepared.count == 1 && IncomingDrop.isAudio(fileName: prepared[0].fileName, mime: prepared[0].mime)
    }

    /// Annuleren is offered only while it is TRUE: before Versturen, or after
    /// a refusal that left nothing behind. From `.saving` on, the drops are
    /// written and the app WILL send them (each one a permanent
    /// `document.ingested`), so a cancel there would cancel nothing; the
    /// screen waits, then offers only Sluiten.
    var canCancel: Bool {
        switch phase {
        case .loading, .ready, .refused: true
        case .saving, .done, .handedToApp: false
        }
    }

    /// What did not go, shown beside every phase after loading (before
    /// Versturen AND under "Staat in je dossier."), so a partial share never
    /// reads as a whole one.
    var warning: String? {
        guard leftOut > 0, !prepared.isEmpty else { return nil }
        return Copy.leftOut(leftOut, of: handedOver)
    }

    /// The screen closes itself after Versturen only when there is nothing
    /// to read; with a warning, Martin closes it.
    var closesByItself: Bool { warning == nil && phase != .handedToApp }

    /// Versturen.
    func commit() async {
        guard phase == .ready else { return }
        guard let groupDir else { phase = .refused(Copy.noGroup); return }
        phase = .saving
        if isAudio {
            // Never uploaded from here: verder transcribes it on the phone,
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
                phase = .refused(Copy.saveFailed)
                return
            }
            phase = .handedToApp
            return
        }
        var ids: [UUID] = []
        do {
            for file in prepared {
                switch file.content {
                case .data(let data):
                    ids.append(try IncomingDrop.write(file: data, fileName: file.fileName, mime: file.mime,
                                                      capturedAt: now(), to: groupDir))
                case .file(let url):
                    ids.append(try IncomingDrop.write(fileAt: url, fileName: file.fileName, mime: file.mime,
                                                      capturedAt: now(), to: groupDir))
                }
            }
        } catch {
            // Nothing has been sent yet, so the drops already written are
            // taken back: "Dit kon niet worden bewaard" must mean that NOTHING
            // of this share will reach the dossier, and Annuleren stays true.
            for id in ids { IncomingDrop.remove(id, groupDir: groupDir) }
            phase = .refused(Copy.saveFailed)
            return
        }
        let sender = sender, bound = sendBound, written = ids
        let delivered = await withTaskGroup(of: [UUID]?.self) { group in
            group.addTask { await sender(written, groupDir) }
            group.addTask {
                try? await Task.sleep(for: bound)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first ?? []
        }
        phase = .done(delivered: Set(delivered) == Set(ids))
    }

    var message: String? {
        switch phase {
        case .loading: Copy.loading
        case .ready: nil
        case .saving: Copy.saving
        case .done(let delivered): delivered ? Copy.delivered : Copy.queued
        case .handedToApp: Copy.openToTranscribe
        case .refused(let why): why
        }
    }
}

private extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
