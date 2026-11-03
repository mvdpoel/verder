import Foundation

/// Every word the Scan tab and its queue show, decided here from the queue's
/// items (Figma "scan · final"). The views only lay it out, so a test can read
/// each state the frames draw without a simulator.
///
/// NOTHING HERE IS AMBER. A scan on its way, one waiting for the network, one
/// that failed or one held for a sign-in is the system's state, not something
/// in the dossier waiting on Martin (brief §2.1). The one action in each
/// state ("Opnieuw proberen", "Opnieuw inloggen") is signal.
struct ScanScreen: Equatable {
    /// The duplex merge window (`apps/worker/src/duplex.ts`): the backs must
    /// arrive within 10 minutes of the fronts. The worker holds a `scanNNNN`
    /// for 12; the screen promises the safe 10.
    static let duplexWindow: TimeInterval = 10 * 60

    /// What the queue holds, as the tab sees it.
    struct Input {
        var items: [UploadItem]
        var signInRequired = false
        var offline = false
        /// Captures being packed into a PDF right now: already on their way.
        var preparing = 0
        var everEnqueued = false
        var now: Date
    }

    /// The one line between the title and the disc.
    enum Slot: Equatable {
        case none
        /// "Iets bijzonders bij 14:32?" — a note for the capture just taken.
        case note(UUID, time: String)
        /// An icon and a sentence: offline, failed or waiting for sign-in.
        case line(symbol: String, text: String)
    }

    struct Duplex: Equatable {
        let label: String
        let text: String
    }

    let eyebrow: String
    let slot: Slot
    let discTitle: String
    let discSubtitle: String?
    let duplex: Duplex
    let accessory: QueueAccessory?
    /// The capture the duplex window and the note chip are about.
    let recent: UploadItem?

    init(_ input: Input) {
        let underway = input.items.filter { $0.state == .pending || $0.state == .sending }
        let failed = input.items.filter { $0.state == .failed }
        let firstTime = !input.everEnqueued && input.items.isEmpty && input.preparing == 0

        let recent = input.items
            .filter { $0.source == "phone-scan" && $0.capturedAt <= input.now
                && input.now.timeIntervalSince($0.capturedAt) < Self.duplexWindow }
            .max { $0.capturedAt < $1.capturedAt }
        self.recent = recent

        eyebrow = input.offline ? "offline" : HomeSummary.longDay(input.now)

        if let recent, recent.note == nil, recent.state != .sent {
            slot = .note(recent.id, time: HomeSummary.clock(recent.capturedAt))
        } else if input.signInRequired, !underway.isEmpty {
            slot = .line(symbol: "lock", text: underway.count == 1
                ? "Je scan staat veilig op dit toestel."
                : "Je \(underway.count) scans staan veilig op dit toestel.")
        } else if let first = failed.min(by: { $0.capturedAt < $1.capturedAt }) {
            slot = .line(symbol: "exclamationmark.circle", text: failed.count == 1
                ? "\(HomeSummary.clock(first.capturedAt)) niet verstuurd, staat veilig op dit toestel."
                : "\(failed.count) scans niet verstuurd, ze staan veilig op dit toestel.")
        } else if input.offline {
            slot = .line(symbol: "wifi.slash", text: "Scannen werkt gewoon zonder verbinding.")
        } else {
            slot = .none
        }

        if firstTime {
            discTitle = "Nog geen scans — scan je eerste brief"
            discSubtitle = Self.howTo
        } else if recent != nil {
            discTitle = "Volgende brief scannen"
            discSubtitle = nil
        } else {
            discTitle = "Scan een brief"
            discSubtitle = Self.howTo
        }

        if let recent {
            let left = Self.duplexWindow - input.now.timeIntervalSince(recent.capturedAt)
            let minutes = max(1, Int((left / 60).rounded(.up)))
            duplex = Duplex(label: "Dubbelzijdig · nog \(minutes) min",
                            text: "Achterkanten van deze brief? Draai de stapel om over de lange kant en scan ze nu. verder legt ze samen.")
        } else {
            duplex = Duplex(label: "Dubbelzijdig",
                            text: "Draai de stapel om over de lange kant en scan binnen 10 minuten de achterkanten. verder legt ze samen.")
        }

        accessory = QueueAccessory(input)
    }

    static let howTo = "Leg de brief plat neer, de camera doet de rest."
}

/// The queue's line above the tab bar, while there is anything to say.
struct QueueAccessory: Equatable {
    enum Action: Equatable { case retry, signIn }

    let symbol: String
    let title: String
    /// The accessibility sizes: two words, so it still fits one line.
    let compactTitle: String
    let meta: String
    let action: Action?

    var actionTitle: String? {
        switch action {
        case .retry: "Opnieuw proberen"
        case .signIn: "Opnieuw inloggen"
        case nil: nil
        }
    }

    var accessibilityLabel: String { "Wachtrij. \(title). \(HomeSummary.sentence(meta.lowercased()))." }

    /// Nil when nothing was queued today and nothing waits: the tab is just
    /// the disc. Order: a sign-in stops everything; then a failure, which
    /// Martin can fix; then the connection; then what is on its way; then
    /// today's "Alles is verstuurd".
    init?(_ input: ScanScreen.Input) {
        let underway = input.items.filter { $0.state == .pending || $0.state == .sending }
        let failed = input.items.filter { $0.state == .failed }
        let sentToday = QueueSheet.sentToday(input.items, now: input.now)
        let moving = underway.count + input.preparing

        if input.signInRequired, !underway.isEmpty {
            let n = underway.count
            symbol = "lock"
            title = n == 1 ? "1 wacht" : "\(n) wachten"
            compactTitle = title
            meta = "Log opnieuw in om te versturen"
            action = .signIn
        } else if !failed.isEmpty {
            symbol = "exclamationmark.circle"
            title = "Niet verstuurd"
            compactTitle = "\(failed.count) mislukt"
            meta = failed.count == 1 ? QueueSheet.failureMeta(failed[0]) : "\(failed.count) scans"
            action = .retry
        } else if input.offline, !underway.isEmpty {
            let n = underway.count
            symbol = "wifi.slash"
            title = n == 1 ? "1 scan wacht op verbinding" : "\(n) scans wachten op verbinding"
            compactTitle = n == 1 ? "1 wacht" : "\(n) wachten"
            meta = "Verstuurd zodra je online bent"
            action = nil
        } else if moving > 0 {
            symbol = "arrow.up.circle"
            title = moving == 1 ? "1 scan wordt verstuurd" : "\(moving) scans worden verstuurd"
            compactTitle = "\(moving) bezig"
            if moving == 1, let item = underway.first {
                meta = [QueueSheet.pagesLabel(item), "scan \(HomeSummary.clock(item.capturedAt))"]
                    .compactMap { $0 }.joined(separator: " · ")
            } else if let newest = underway.max(by: { $0.capturedAt < $1.capturedAt }) {
                meta = "Laatste \(HomeSummary.clock(newest.capturedAt))"
            } else {
                meta = "Wordt klaargemaakt"
            }
            action = nil
        } else if let last = sentToday.first {
            symbol = "checkmark.circle"
            title = "Alles is verstuurd"
            compactTitle = "Alles verstuurd"
            meta = "Vandaag \(sentToday.count) \(sentToday.count == 1 ? "scan" : "scans") · laatste \(HomeSummary.clock(last.capturedAt))"
            action = nil
        } else {
            return nil
        }
    }
}

/// The "Wachtrij" sheet: sections in the order Martin acts on them.
struct QueueSheet: Equatable {
    /// Sent rows shown before "Toon alle n".
    static let sentPreview = 2

    struct Row: Identifiable, Equatable {
        enum Badge: String, Equatable {
            case failed = "exclamationmark"
            case sending = "arrow.up"
            case offline = "wifi.slash"
            case signIn = "lock.fill"
            case sent = "checkmark"
        }

        let id: UUID
        let title: String
        let meta: String
        let badge: Badge
        /// The failed row's explanation under its meta.
        let detail: String?
        let note: String?
        let documentId: String?
        let canRetry: Bool
        let canNote: Bool
        let canRemove: Bool

        var accessibilityLabel: String {
            [title, HomeSummary.sentence(meta.lowercased()), note.map { "Notitie: \($0)" }, detail]
                .compactMap { $0 }.joined(separator: ". ")
        }
    }

    struct Section: Identifiable, Equatable {
        enum Kind: Equatable { case failed, underway, offline, signIn, sent }
        let kind: Kind
        let title: String
        let rows: [Row]
        /// "Toon alle 9": sent rows beyond the preview.
        let hidden: Int
        var id: String { title }
    }

    let sections: [Section]
    let footer: String

    init(_ input: ScanScreen.Input, showAllSent: Bool = false) {
        var sections: [Section] = []
        let failed = input.items.filter { $0.state == .failed }.sorted { $0.capturedAt < $1.capturedAt }
        let underway = input.items.filter { $0.state == .pending || $0.state == .sending }
            .sorted { $0.capturedAt < $1.capturedAt }
        let sent = Self.sentToday(input.items, now: input.now)

        if !failed.isEmpty {
            sections.append(Section(kind: .failed, title: "Niet verstuurd · \(failed.count)", rows: failed.map { item in
                Row(id: item.id, title: Self.title(item), meta: Self.failureMeta(item), badge: .failed,
                    detail: item.failure == .refused
                        ? "verder nam dit bestand niet aan. Opnieuw proberen stuurt het nog eens."
                        : "Staat veilig op dit toestel. Tik Opnieuw proberen om het nog eens te versturen.",
                    note: item.note, documentId: nil, canRetry: true, canNote: true, canRemove: true)
            }, hidden: 0))
        }
        if !underway.isEmpty {
            let kind: Section.Kind = input.signInRequired ? .signIn : input.offline ? .offline : .underway
            let label = switch kind {
            case .signIn: "Wacht op inloggen"
            case .offline: "Wacht op verbinding"
            default: "Wordt verstuurd"
            }
            let badge: Row.Badge = switch kind {
            case .signIn: .signIn
            case .offline: .offline
            default: .sending
            }
            sections.append(Section(kind: kind, title: "\(label) · \(underway.count)", rows: underway.map { item in
                let meta = kind == .underway
                    ? (item.byteCount.map(Self.size) ?? "Wordt verstuurd")
                    : "Staat veilig op dit toestel"
                return Row(id: item.id, title: Self.title(item), meta: meta, badge: badge, detail: nil,
                           note: item.note, documentId: nil, canRetry: false, canNote: true,
                           canRemove: item.state == .pending)
            }, hidden: 0))
        }
        if !sent.isEmpty {
            let shown = showAllSent ? sent : Array(sent.prefix(Self.sentPreview))
            sections.append(Section(kind: .sent, title: "Verstuurd vandaag · \(sent.count)", rows: shown.map { item in
                Row(id: item.id, title: Self.title(item),
                    meta: "Verstuurd \(item.sentAt.map(HomeSummary.clock) ?? "") · in Dossier", badge: .sent,
                    detail: nil, note: item.note, documentId: item.documentId,
                    canRetry: false, canNote: false, canRemove: false)
            }, hidden: sent.count - shown.count))
        }
        self.sections = sections

        if input.signInRequired, !underway.isEmpty {
            footer = "Na het inloggen worden ze vanzelf verstuurd. Verstuurde scans staan in Dossier."
        } else if input.offline, !underway.isEmpty {
            footer = "Ze worden vanzelf verstuurd zodra je online bent. Verstuurde scans staan in Dossier."
        } else {
            footer = "Verstuurde scans staan in Dossier. Deze lijst begint morgen weer leeg."
        }
    }

    /// Sent on the Amsterdam calendar day of `now`, newest scan first.
    static func sentToday(_ items: [UploadItem], now: Date) -> [UploadItem] {
        let cal = HomeSummary.calendar
        return items
            .filter { $0.state == .sent && $0.sentAt.map { cal.isDate($0, inSameDayAs: now) } == true }
            .sorted { $0.capturedAt > $1.capturedAt }
    }

    /// "Scan 14:32 · 2 pagina's"; a shared file keeps its own name.
    static func title(_ item: UploadItem) -> String {
        guard item.source == "phone-scan" else { return item.fileName }
        return ["Scan \(HomeSummary.clock(item.capturedAt))", pagesLabel(item)].compactMap { $0 }
            .joined(separator: " · ")
    }

    static func pagesLabel(_ item: UploadItem) -> String? {
        item.pages.map { $0 == 1 ? "1 pagina" : "\($0) pagina's" }
    }

    static func failureMeta(_ item: UploadItem) -> String {
        switch item.failure {
        case .refused: "Niet aangenomen"
        case .missingFile: "Bestand ontbreekt"
        case .noAnswer, nil: "Geen antwoord"
        }
    }

    /// "1,4 MB", the Dutch way.
    static func size(_ bytes: Int) -> String {
        if bytes < 1_000_000 { return "\(max(1, Int((Double(bytes) / 1000).rounded()))) kB" }
        let mb = (Double(bytes) / 100_000).rounded() / 10
        return mb.formatted(.number.precision(.fractionLength(1)).locale(Locale(identifier: "nl_NL"))) + " MB"
    }
}
