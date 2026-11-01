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
    }

    /// Under the server's 50 MB (`MAX_UPLOAD_BYTES`), leaving room for the
    /// multipart envelope; also well inside an extension's memory budget.
    static let maxFileBytes = 48 * 1024 * 1024

    private(set) var phase: Phase = .loading
    private(set) var prepared: [PreparedShare] = []
    /// How many photos went into the one PDF, for the detail line.
    private(set) var photoCount = 0

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

    /// The share sheet's items, loaded.
    func loaded(_ inputs: [SharedInput]) {
        photoCount = inputs.count { if case .image = $0 { true } else { false } }
        prepared = SharePreparation.prepare(inputs, capturedAt: now())
        if prepared.isEmpty {
            phase = .refused(Copy.nothing)
        } else if prepared.contains(where: { $0.data.count > Self.maxFileBytes }) {
            phase = .refused(Copy.tooLarge)
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
        if photoCount > 0 { parts.append(photoCount == 1 ? "1 foto als PDF" : "\(photoCount) foto's als één PDF") }
        let others = prepared.count - (photoCount > 0 ? 1 : 0)
        if others > 0, photoCount > 0 { parts.append(others == 1 ? "1 bestand" : "\(others) bestanden") }
        if photoCount == 0, prepared.count == 1 {
            parts.append(((prepared[0].fileName as NSString).pathExtension.uppercased()).ifEmpty("Bestand"))
        }
        let bytes = prepared.reduce(0) { $0 + $1.data.count }
        parts.append(bytes.formatted(.byteCount(style: .file).locale(Locale(identifier: "nl_NL"))))
        return parts.joined(separator: " · ")
    }

    var canSend: Bool { phase == .ready }

    /// Versturen.
    func commit() async {
        guard phase == .ready else { return }
        guard let groupDir else { phase = .refused(Copy.noGroup); return }
        phase = .saving
        var ids: [UUID] = []
        do {
            for file in prepared {
                ids.append(try IncomingDrop.write(file: file.data, fileName: file.fileName, mime: file.mime,
                                                  capturedAt: now(), to: groupDir))
            }
        } catch {
            // Whatever was written stays a valid drop and is queued by the app;
            // Martin is told the share as a whole did not go through.
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
        case .refused(let why): why
        }
    }
}

private extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
