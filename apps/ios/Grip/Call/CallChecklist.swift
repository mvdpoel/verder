import Foundation

/// The two lists on the call sheet, in the order they are shown.
enum CallList: String, CaseIterable, Sendable {
    case tell, ask

    var title: String {
        switch self {
        case .tell: "Vertellen"
        case .ask: "Vragen"
        }
    }

    var emptyText: String {
        switch self {
        case .tell: "Niets om te vertellen."
        case .ask: "Niets om te vragen."
        }
    }
}

/// One point on the sheet, with the list it is on.
struct CallPoint: Equatable, Identifiable, Sendable {
    let point: TalkingPointsDTO.Point
    let list: CallList
    var id: String { point.id }
    var text: String { point.text }
    var link: String { point.source.link }
}

/// The talking points as something Martin ticks off during a call. Pure: the
/// sheet, the Live Activity and the voice prefill all read their words and
/// counts from here, so the three can never disagree.
///
/// ORDER: Vertellen, then Vragen, each in the server's own order (the server
/// ranks; the phone never re-ranks). The "next" point — the one the Live
/// Activity shows — is the first unticked one in that order.
struct CallChecklist: Equatable, Sendable {
    private(set) var points: [CallPoint]
    private(set) var ticked: Set<String> = []

    init(_ dto: TalkingPointsDTO) {
        points = Self.points(dto)
    }

    private static func points(_ dto: TalkingPointsDTO) -> [CallPoint] {
        dto.tell.map { CallPoint(point: $0, list: .tell) } + dto.ask.map { CallPoint(point: $0, list: .ask) }
    }

    func items(_ list: CallList) -> [CallPoint] { points.filter { $0.list == list } }

    func isTicked(_ id: String) -> Bool { ticked.contains(id) }

    /// A tap on a point's checkbox. An id that is not on the sheet does nothing.
    mutating func toggle(_ id: String) {
        guard points.contains(where: { $0.id == id }) else { return }
        if ticked.contains(id) { ticked.remove(id) } else { ticked.insert(id) }
    }

    /// A refresh from the server: the ids are stable, so a point that is still
    /// there keeps its tick, and a tick on a point that went is dropped.
    mutating func replace(with dto: TalkingPointsDTO) {
        points = Self.points(dto)
        ticked.formIntersection(points.map(\.id))
    }

    var total: Int { points.count }
    var discussed: Int { points.filter { ticked.contains($0.id) }.count }
    var nextOpen: CallPoint? { points.first { !ticked.contains($0.id) } }

    /// "2 van 5 besproken".
    var progressText: String {
        total == 0 ? "Geen gesprekspunten" : "\(discussed) van \(total) besproken"
    }

    /// What the voice quick-log starts from once the call has ended: the
    /// ticked points in the sheet's order, or nothing when none was ticked.
    /// Martin's own words (dictated or typed) go under it, and the whole is a
    /// SUGGESTION he approves in Voor jou like any other.
    var prefillText: String {
        let done = points.filter { ticked.contains($0.id) }
        guard !done.isEmpty else { return "" }
        return (["Besproken:"] + done.map { "- \($0.text)" }).joined(separator: "\n")
    }

    /// What the Live Activity is told. The next point's TEXT travels so the
    /// expanded Dynamic Island can show it; the lock screen and the compact
    /// island never draw it (`CallActivityFaces`).
    var activityState: CallActivityAttributes.ContentState {
        .init(discussed: discussed, total: total, nextPoint: nextOpen.map { CallActivityFaces.shorten($0.text) })
    }
}

/// The call sheet's words that are not a list's own.
enum CallCopy {
    static let title = "Gesprek voorbereiden"
    static let offlineNothing = "Geen verbinding, en deze punten staan nog niet op je telefoon."
    static let failed = "De gesprekspunten konden niet worden opgehaald."
    static let notFound = "Deze partij staat niet (meer) in je dossier."
    static let loading = "Gesprekspunten ophalen…"
    static let noNumber = "Geen telefoonnummer bekend in Grip. Bel zoals je gewend bent; zet de punten wel op je toegangsscherm."
    static let activitiesOff = "Live Activities staan uit voor Grip. Zet ze aan in Instellingen › Grip."
    static let showDuring = "Toon tijdens het gesprek"
    static let stopShowing = "Niet meer tonen"
    static let showing = "Op je toegangsscherm en in het Dynamic Island: alleen het aantal, nooit namen of punten."
    static let ended = "Het gesprek is afgelopen."
    static let logCall = "Gesprek vastleggen"
    static let notNow = "Niet nu"
    /// What iOS does not allow, said once, plainly (see `TalkingPointsDTO`).
    static let noListening = "Grip luistert niet mee: iOS laat geen app een telefoongesprek opnemen. Leg het na afloop vast met je stem."

    /// "AI-samenvatting · 30 okt": the AI line is always marked as AI, with
    /// the day it was written, so it is never read as a dossier fact.
    static func summaryLabel(_ s: TalkingPointsDTO.Summary) -> String {
        "AI-samenvatting · \(MoneyFormat.day(s.generatedAt))"
    }

    struct SourceLink: Equatable, Sendable, Identifiable {
        let label: String
        let link: String
        let id: String
    }

    /// The AI line's sources, as rows that open their screen.
    static func sources(_ s: TalkingPointsDTO.Summary) -> [SourceLink] {
        s.sourceRefs.map { SourceLink(label: typeLabel($0.type), link: link(type: $0.type, id: $0.id), id: "\($0.type):\($0.id)") }
    }

    static func typeLabel(_ type: String) -> String {
        switch type {
        case "mail": "Mail"
        case "task": "Taak"
        case "debt": "Vordering"
        case "document": "Document"
        case "proposal": "Voorstel"
        case "stop": "Halte"
        default: "Dossier"
        }
    }

    /// The same mapping the server uses for a point's `link`: a task,
    /// proposal or document opens its own screen, a stop the Tijdlijn, and
    /// a mail or a debt — which have no screen on the phone — the Dossier.
    static func link(type: String, id: String) -> String {
        switch type {
        case "task", "proposal", "document":
            UUID(uuidString: id) == nil ? "grip://dossier" : "grip://\(type)/\(id.lowercased())"
        case "stop": "grip://timeline"
        default: "grip://dossier"
        }
    }

    /// "Bel": a `tel:` link to the party's number, or nil. Only digits, one
    /// leading `+` and the usual separators are read; anything else (an
    /// extension, a note typed into the field) gives NO link rather than a
    /// guess at which digits to dial.
    static func dialURL(_ phone: String?) -> URL? {
        guard let phone else { return nil }
        let trimmed = phone.trimmingCharacters(in: .whitespaces)
        let separators = CharacterSet(charactersIn: " -.()/\u{00A0}")
        var digits = ""
        for (i, ch) in trimmed.unicodeScalars.enumerated() {
            if CharacterSet.decimalDigits.contains(ch) && ch.isASCII { digits.unicodeScalars.append(ch) }
            else if ch == "+" && i == 0 { digits.append("+") }
            else if separators.contains(ch) { continue }
            else { return nil }
        }
        guard digits.filter(\.isNumber).count >= 3 else { return nil }
        return URL(string: "tel:\(digits)")
    }
}
