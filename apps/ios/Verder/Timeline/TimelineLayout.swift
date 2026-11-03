import CoreGraphics
import Foundation

/// The words of the Tijdlijn, decided outside the view.
enum TimelineCopy {
    static let eyebrow = "De zaak"
    static let title = "Tijdlijn"
    static let rowTitle = "Tijdlijn"
    static let rowLine = "De zaak, het nieuwste bovenaan"
    static let headlineLabel = "Waar het nu op wacht"
    /// The pinned strip at the accessibility sizes: only the eyebrow is drawn.
    static let stripShort = "Wacht op jou"
    static let noHeadline = "Er staat op dit moment geen halte open."
    static let filterLabel = "Filter"
    static let allTracks = "Alle sporen"
    static let hideDebts = "Schuldeisers verbergen"
    static let filterFooter = "Verbergt de vorderingen en de brieven waarmee ze begonnen. "
        + "Wacht daar iets op jou, dan zie je dat bovenaan."
    static let showAll = "Toon alle sporen"
    static let emptyTitle = "Nog geen sporen op je tijdlijn"
    static let emptyBody = "Hier zie je straks je zaak van nu naar vroeger: wat er gebeurde en wat er op je wacht. "
        + "Sporen en haltes maak je op de website."
    static let emptyVoorJou = "Wat nu op je wacht, staat in Voor jou."
    static let openVoorJou = "Open Voor jou"
    static let offlineNothing = "Geen verbinding — de tijdlijn staat nog niet op je telefoon."
    static let failedTitle = "De tijdlijn kon niet laden"
    static let failedBody = "De server reageert even niet. Probeer het zo opnieuw. "
        + "Wat al op je telefoon staat, kun je in je dossier en Voor jou gewoon bekijken."
    static let retry = "Opnieuw proberen"
    static let quietMonth = "geen haltes"
    static let unknownBand = "Onbekend"
    static let noUndated = "geen haltes zonder datum"
    static let notToScale = "Niet op schaal · binnen een maand staan haltes op gelijke afstand"
    static let outOfOrder = "De datum van deze halte ligt vóór de halte ervoor. De kaart tekent de volgorde zoals hij is "
        + "ingevoerd — meestal betekent dit dat deze halte op een ander spoor thuishoort."
    static let flagged = "datum vóór de vorige halte"
    static let problemsLabel = "Wat de kaart niet kon tekenen"
    static let close = "Sluiten"
    static let showTrack = "Toon spoor op de tijdlijn"
    static let editOnWeb = "Haltes en sporen pas je aan op de website."
    static let noteLabel = "Notitie"
    static let noNote = "Geen notitie."
    static let trackLabel = "Spoor"
    static let behindLabel = "Wat erachter hangt"
    static let nothingBehind = "Niets gekoppeld."
    static let linkOnWeb = "Koppelen doe je op de website"
    static let view = "Bekijken"
    static let openTask = "Open taak"
    static let openDocument = "Open document"

    /// The legend under the map, one mark per line. Every open stop waits on
    /// Martin (the project's rule for the case map), so one amber ring says it.
    enum LegendMark: CaseIterable { case done, waiting, junction, running, end }

    static func legend(_ mark: LegendMark) -> String {
        switch mark {
        case .done: "gebeurd"
        case .waiting: "wacht op jou"
        case .junction: "splitst af of komt samen"
        case .running: "spoor loopt nog"
        case .end: "begin of einde van een lijn"
        }
    }

    static func count(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }

    /// "4 sporen · 14 haltes · nieuwste 30 okt", as parts: one line at the
    /// ordinary sizes, one fact per line at the accessibility sizes.
    static func stats(_ map: CaseMapDTO) -> [String] {
        let sporen = map.tracks.filter { !$0.isRoot }.count
        var parts = [count(sporen, "spoor", "sporen"), count(map.stops.count, "halte", "haltes")]
        if let newest = map.stops.compactMap(\.happenedAt).max() {
            parts.append("nieuwste \(MoneyFormat.day(newest))")
        }
        return parts
    }

    static func hiddenCount(_ n: Int) -> String { count(n, "spoor verborgen", "sporen verborgen") }

    /// The open stops the filter took off the map: in the full map and not in
    /// the shown one. Nil when the full map was never seen on this phone.
    static func hiddenOpen(full: CaseMapDTO?, shown: CaseMapDTO) -> Int? {
        guard let full else { return nil }
        let shownIds = Set(shown.stops.map(\.id))
        return full.stops.filter { $0.state == "open" && !shownIds.contains($0.id) }.count
    }

    static func hiddenOpenLine(_ n: Int) -> String { "daarin wacht \(n) op jou" }

    /// "offline · tijdlijn van 09:20" — the age of a kept map, in Amsterdam
    /// time, with the day when it was not today.
    static func kept(_ prefix: String, savedAt: Date?, now: Date) -> String {
        guard let savedAt else { return prefix }
        return "\(prefix) · tijdlijn van \(clock(savedAt, now: now))"
    }

    /// "14:05", or "31 okt 22:14" when not today.
    static func clock(_ at: Date, now: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        let c = cal.dateComponents([.hour, .minute], from: at)
        let time = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        return cal.isDate(at, inSameDayAs: now) ? time : "\(MoneyFormat.day(at)) \(time)"
    }

    /// "niet geladen · 14:05".
    static func notLoaded(at: Date?, now: Date) -> String {
        at.map { "niet geladen · \(clock($0, now: now))" } ?? "niet geladen"
    }

    /// The VoiceOver hint on Opnieuw proberen: what the last attempt answered.
    static func retryHint(_ error: APIError) -> String {
        switch error {
        case .server(let code): "Laatste poging gaf serverfout \(code)."
        case .rejected(let code): "Laatste poging werd geweigerd (\(code))."
        case .rateLimited: "Laatste poging: te veel verzoeken."
        case .transport: "Laatste poging kreeg geen verbinding."
        case .unauthorized: "Log opnieuw in."
        }
    }

    /// The spoor's status in words. `ended` is geëindigd — handled and closed,
    /// a clean outcome — and is never worded as a failure.
    static func trackStatus(_ status: String) -> String {
        switch status {
        case "done": "afgerond"
        case "ended": "geëindigd"
        default: "loopt nog"
        }
    }

    /// The outcome badge of a spoor in the stop sheet. An OPEN spoor reads as
    /// running — never as one that "ends on its own" — and an ended one as
    /// afgehandeld, a clean outcome.
    static func outcome(_ track: CaseMapDTO.Track) -> String {
        switch track.terminus {
        case "merge": "terug op de hoofdlijn"
        case "ended": "afgehandeld"
        case "done": "afgerond"
        default: "loopt nog"
        }
    }

    /// The sentence under the outcome badge, with the spoor's own note (what
    /// the episode was about — Martin's words, from the web) woven in. Nothing
    /// here is invented: the merge stop and its date are the map's own; an
    /// open spoor only runs.
    static func outcomeSentence(_ track: CaseMapDTO.Track, mergedAt: CaseMapDTO.Stop?) -> String {
        let note = track.note.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
        let tail = note.map { " " + sentenceEnded($0) } ?? ""
        switch track.terminus {
        case "merge":
            guard let stop = mergedAt else { return "Dit spoor kwam terug op de hoofdlijn." + tail }
            let when = stop.happenedAt.map { " van \(longDay($0))" } ?? ""
            return "Dit spoor kwam terug op de hoofdlijn bij \(stopPhrase(stop.title))\(when)." + tail
        case "ended":
            // "afgehandeld: de huurachterstand is geregeld en hoefde niet terug…"
            if let note { return "Dit spoor is afgehandeld: \(clause(note)) en hoefde niet terug naar de hoofdlijn. Goed gedaan." }
            return "Dit spoor is afgehandeld en hoefde niet terug naar de hoofdlijn. Goed gedaan."
        case "done": return "Dit spoor is afgerond. Goed gedaan." + tail
        default: return "Dit spoor loopt nog." + tail
        }
    }

    /// A stop named in running prose. A title of the form "Beschikking: onder
    /// bewind gesteld" reads as "de beschikking"; any other title is quoted
    /// whole, because an article cannot be derived from a free title.
    static func stopPhrase(_ title: String) -> String {
        if let colon = title.firstIndex(of: ":") {
            let head = title[..<colon].trimmingCharacters(in: .whitespaces)
            if !head.isEmpty, !head.contains(" ") { return "de \(head.lowercased())" }
        }
        return "\u{201E}\(title)\u{201D}"
    }

    /// "3 juni": the day in full, for a sentence.
    static func longDay(_ d: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        let c = cal.dateComponents([.day, .month], from: d)
        return "\(c.day ?? 1) \(MoneyFormat.monthsLong[(c.month ?? 1) - 1])"
    }

    /// A note as a clause inside a sentence: first letter lower-cased (unless
    /// the first word carries another capital — "KvK", "CAK"), trailing full
    /// stop dropped.
    static func clause(_ note: String) -> String {
        var s = note
        while let last = s.last, ".!".contains(last) { s.removeLast() }
        let first = s.prefix(while: { !$0.isWhitespace })
        guard first.count > 1, !first.dropFirst().contains(where: \.isUppercase) else { return s }
        return s.prefix(1).lowercased() + s.dropFirst()
    }

    static func sentenceEnded(_ s: String) -> String {
        guard let last = s.last, !".!?".contains(last) else { return s }
        return s + "."
    }

    /// For a stop on the hoofdlijn: the sporen still running beside it. At
    /// the current stop they run INTO it — the dashed line ends there.
    static func runningSentence(_ titles: [String], intoHere: Bool = false) -> String? {
        let tail = intoHere ? " en komt hier uit." : "."
        switch titles.count {
        case 0: return nil
        case 1: return "Het spoor \(titles[0]) loopt nog\(tail)"
        default:
            let tails = intoHere ? " en komen hier uit." : "."
            return "De sporen \(titles.dropLast().joined(separator: ", ")) en \(titles.last!) lopen nog\(tails)"
        }
    }

    /// "12 mei – 3 jun · 2 haltes".
    static func span(from: Date?, to: Date?, stops: Int) -> String {
        let days = [from, to].compactMap { $0.map(MoneyFormat.day) }
        var parts: [String] = []
        if days.count == 2, days[0] != days[1] { parts.append("\(days[0]) – \(days[1])") }
        else if let d = days.first { parts.append(d) }
        parts.append(count(stops, "halte", "haltes"))
        return parts.joined(separator: " · ")
    }

    /// The stop's state badge: every open stop waits on Martin (amber), steel
    /// for done.
    static func stateBadge(isCurrent: Bool, state: String) -> String {
        isCurrent || state == "open" ? "wacht op jou" : "gebeurd"
    }

    /// "nu · zonder datum", "26 mei".
    static func when(_ stop: CaseMapDTO.Stop) -> String {
        if let at = stop.happenedAt { return MoneyFormat.day(at) }
        return stop.bandKey == "nu" ? "nu · zonder datum" : "zonder datum"
    }

    /// "Voor jou · taak · te laat sinds 30 okt".
    @MainActor static func taskLine(_ task: CaseMapDTO.Evidence.TaskLink, now: Date) -> String {
        var parts: [String] = []
        let waiting = ["open", "in-progress", "waiting"].contains(task.status)
        if waiting { parts.append("voor jou") }
        parts.append("taak")
        if let due = task.dueAt {
            parts.append(due < now && waiting ? "te laat sinds \(MoneyFormat.day(due))" : "uiterlijk \(MoneyFormat.day(due))")
        } else if !waiting {
            parts.append(TaskModel.label(task.status))
        }
        return parts.joined(separator: " · ")
    }

    /// "document · loonstrook · opent in dossier" — or, offline, whether the
    /// phone holds it.
    static func documentLine(docType: String?, held: Bool, offline: Bool) -> String {
        // Offline and not on the phone, the line says only what it waits for.
        if offline && !held { return "opent met verbinding" }
        var parts = ["document"]
        if let t = DossierCopy.docTypeLabel(docType), !offline { parts.append(t) }
        parts.append(offline ? (held ? "op je telefoon" : "opent met verbinding") : "opent in dossier")
        return parts.joined(separator: " · ")
    }

    static func notOnPhone(_ title: String) -> String {
        "\(title) staat niet op je telefoon. Hij opent zodra je weer verbinding hebt."
    }
}

/// What the Tijdlijn draws, as plain decisions — the phone's `track-marks.ts`.
/// PURE: a `CaseMapDTO` in, rows out. The view draws what comes out of here one
/// to one and decides nothing else.
///
/// The page is a list of ITEMS in the map's own order, newest first: a header
/// per month band (quiet months included — a stretch where nothing happened is
/// a fact about the case), then that band's stops by `row`. Each item carries
/// the RAILS that cross it, so the view draws every row's slice of the lanes
/// in the row's own height and the slices meet: no text is ever measured here,
/// and a title is never cut to fit a fixed row.
///
/// Connectors are a curve in ONE row. A branch leaves the parent's dot at the
/// branch stop and rises into the spoor's lane; the spoor's rail then runs up
/// to its oldest stop. When the branch stop is newer than the spoor's newest
/// stop, the curve goes DOWN into the spoor's lane instead and the rail runs
/// up to meet it; when it sits INSIDE the spoor's span, the rail stays whole
/// and the curve leaves beside it. A merge comes down the spoor's lane and
/// curves into the parent's dot at the merge stop. A spoor with no recorded
/// branch stop BEGINS with a cap under its oldest stop instead.
///
/// A rail is stretched to its connector ONLY through rows its lane holds for
/// nobody else: `buildTrackMap` packs lanes on stop spans alone, so another
/// spoor may sit in the same lane between a spoor and its trigger. Then the
/// connector is ROUTED instead — a curve at each end and a DETOUR half a lane
/// to the left through the rows between — so two sporen never share a line.
///
/// A spoor that still RUNS but has no open stop (its last step is done and the
/// matter is not closed) is drawn on up towards now as a DASHED rail, through
/// rows its lane holds for nobody else; where the lane is taken it gets a
/// short dashed stub above its newest stop. That is how an open spoor reads as
/// running without the map inventing where it goes.
///
/// At the accessibility sizes (`singleLane`) the lanes collapse onto ONE rail:
/// a 40-point title cannot sit beside four lanes, so every stop is a dot on
/// the same line and the readouts say in words what the lanes would draw.
struct TimelineLayout: Equatable {
    /// The sizes `RailGutter` draws at, in points. They are FIXED — a dot that
    /// shrank with the lane count would stop being readable — so the lane pitch
    /// is derived from them instead, and never the other way round.
    enum Marks {
        static let dotRadius: CGFloat = 4.5
        /// An open stop's outline (a hollow signal ring of the dot's radius).
        static let dotStroke: CGFloat = 1.5
        /// The current stop: a hollow amber ring.
        static let currentRadius: CGFloat = 6
        static let currentStroke: CGFloat = 2
        /// A junction's ring around its dot.
        static let ringRadius: CGFloat = 6.5
        static let ringStroke: CGFloat = 1
        /// Half the width of the bar that begins or ends a line.
        static let capHalfWidth: CGFloat = 6
        /// How far a cap sits above (end) or below (begin) its dot.
        static let capOffset: CGFloat = 12
        /// Half the root rail's 3 pt stroke — the widest line in the gutter.
        static let railHalfWidth: CGFloat = 1.5
        /// Half a detour's (and a side rail's) 2 pt stroke.
        static let detourHalfWidth: CGFloat = 1

        /// How far the largest mark reaches from its lane's centre.
        static let reach = max(dotRadius + dotStroke / 2, ringRadius + ringStroke / 2,
                               currentRadius + currentStroke / 2, capHalfWidth)
    }

    /// Lane x positions in the gutter left of the labels, at ONE pitch for any
    /// number of lanes: past four the gutter grows and the label column gives
    /// way, rather than the lanes squeezing until caps and rings cover the next
    /// lane's rail and a detour lies on the rail beside it.
    struct Lanes: Equatable {
        /// The smallest pitch at which a detour, half a lane from either rail,
        /// stays clear of the largest mark on both lanes beside it.
        static let minSpacing = 2 * (Marks.reach + Marks.detourHalfWidth)
        static let baseSpacing: CGFloat = max(16, minSpacing)
        /// Lane 0 sits this far into the gutter (24 pt from the screen edge).
        static let inset: CGFloat = 8
        /// From the last lane to the label column.
        static let labelGap: CGFloat = 24
        /// The gutter of up to four lanes: the label column starts at 96 pt on
        /// every phone (Figma: lanes at 24/40/56/72), so the titles of a map
        /// with one spoor line up with those of a map with four.
        static let standardWidth: CGFloat = 80

        let count: Int
        let spacing: CGFloat
        let minWidth: CGFloat

        init(count: Int, minWidth: CGFloat = Self.standardWidth) {
            self.count = count
            self.minWidth = minWidth
            spacing = Self.baseSpacing
        }

        func x(_ lane: Int) -> CGFloat { Self.inset + CGFloat(lane) * spacing }

        /// Where a routed connector runs: half a lane left of the spoor it
        /// serves, so it never lies on any lane's rail.
        func detourX(_ lane: Int) -> CGFloat { x(lane) - spacing / 2 }

        var width: CGFloat { max(minWidth, Self.inset + CGFloat(max(count, 1) - 1) * spacing + Self.labelGap) }
    }

    /// A lane's slice of rail in one row: above the dot, below it, or both —
    /// solid, or dashed where a running spoor is drawn on towards now.
    struct Rail: Equatable, Hashable, Sendable {
        let lane: Int
        let trackId: String
        let isRoot: Bool
        let top: Bool
        let bottom: Bool
        var dashedTop = false
        var dashedBottom = false
    }

    enum CurveEdge: Equatable, Sendable {
        /// Rises from the dot to the top of the row (a branch, the spoor above).
        case top
        /// Comes from the bottom of the row into the dot (a merge, the spoor below).
        case bottom
    }

    struct Curve: Equatable, Sendable {
        enum Kind: Equatable, Sendable { case branch, merge }
        let kind: Kind
        let trackId: String
        /// The lane whose dot it touches — the parent line.
        let centerLane: Int
        /// The spoor's lane, at the edge of the row.
        let edgeLane: Int
        let edge: CurveEdge
        /// The edge end sits on the DETOUR (`Lanes.detourX(edgeLane)`), not on the lane.
        var via: Bool = false
    }

    /// A routed connector passing through a row beside a lane another spoor
    /// holds there: drawn full height at `Lanes.detourX(lane)`.
    struct Detour: Equatable, Hashable, Sendable {
        let lane: Int
        let trackId: String
    }

    /// The bar that begins or ends a line. Afgerond and geëindigd are both
    /// clean outcomes, told apart in the readout's words, never by a colour.
    struct Cap: Equatable, Sendable {
        enum End: Equatable, Sendable {
            /// Above the newest stop of a spoor that is finished.
            case top
            /// Below the oldest stop of a line that starts there.
            case bottom
        }
        let lane: Int
        let end: End
    }

    enum Mark: Equatable, Sendable {
        /// The one stop the map answers with: what is waiting on Martin now.
        case current
        /// Another open stop: also work waiting on Martin (every open stop is,
        /// by the case map's rule), a smaller hollow amber ring.
        case open
        /// It happened.
        case done

        /// Amber is for what waits on Martin: every open stop.
        var isAmber: Bool { self != .done }
    }

    /// One readout line under a title.
    struct Readout: Equatable, Sendable {
        enum Tone: Equatable, Sendable { case label, signal, attn }
        let text: String
        var tone: Tone = .label
    }

    struct BandRow: Equatable, Identifiable {
        let key: String
        let label: String
        let empty: Bool
        let rails: [Rail]
        var detours: [Detour] = []
        var id: String { "band:" + key }
        /// The NU band with stops in it: the hero carries its eyebrow, so the
        /// band draws only its rule.
        var labelHidden = false
    }

    struct StopRow: Equatable, Identifiable {
        let stop: CaseMapDTO.Stop
        let track: CaseMapDTO.Track?
        let mark: Mark
        /// The lane the dot is drawn on (0 for every stop at `singleLane`).
        let lane: Int
        /// The mono lines under the title at the ordinary sizes.
        let readouts: [Readout]
        /// The same facts as sentences, one paragraph each, naming every spoor
        /// that branches or merges here — what the collapsed lanes cannot draw.
        let sentences: [String]
        let rails: [Rail]
        let curves: [Curve]
        let caps: [Cap]
        var detours: [Detour] = []
        var id: String { stop.id }

        /// What VoiceOver reads: the title, the sentences and the outcome words.
        var spoken: String {
            var parts = [stop.title]
            if mark == .current { parts.append(TimelineCopy.headlineLabel.lowercased()) }
            parts += sentences
            if stop.datesOutOfOrder { parts.append("let op: deze datum ligt vóór de vorige halte") }
            return parts.joined(separator: ", ")
        }
    }

    enum Item: Equatable, Identifiable {
        case band(BandRow)
        case stop(StopRow)

        var id: String {
            switch self {
            case .band(let b): b.id
            case .stop(let s): s.id
            }
        }
    }

    /// Full titles, always: a title wraps on as many lines as it needs.
    static let titleLineLimit: Int? = nil

    let items: [Item]
    let lanes: Lanes
    let singleLane: Bool
    /// The undated band is not on the map: the page closes with "geen haltes
    /// zonder datum", so its absence is said rather than implied.
    let hasUndatedBand: Bool

    var isEmpty: Bool { !items.contains { if case .stop = $0 { true } else { false } } }

    /// The label column: everything right of the gutter.
    func labelWidth(total: CGFloat) -> CGFloat { max(total - lanes.width, 0) }

    /// The span a track's rail covers once its connectors are drawn.
    private struct Extent {
        let trackId: String
        let lane: Int
        let isRoot: Bool
        var top: Int
        var bottom: Int
        /// Rows above this one (and its own top half) are drawn dashed: the
        /// spoor's newest stop, when it is drawn on towards now.
        var dashedBelow: Int? = nil
        /// Only the top half of this row is dashed: the stub of a running spoor
        /// whose lane is taken above it.
        var stub: Int? = nil
    }

    /// A routed connector between two curve rows, `top < bottom`; it passes
    /// through every row strictly between them.
    private struct DetourSpan {
        let trackId: String
        let lane: Int
        let top: Int
        let bottom: Int
    }

    private struct Slice: Hashable {
        let row: Int
        let trackId: String
    }

    init(_ map: CaseMapDTO, singleLane: Bool = false) {
        self.singleLane = singleLane
        hasUndatedBand = map.bands.contains { $0.key == "onbekend" }
        lanes = singleLane ? Lanes(count: 1, minWidth: 0) : Lanes(count: map.laneCount)
        let trackById = Dictionary(map.tracks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let tracksWithStops = Set(map.stops.map(\.trackId))
        let drawn = map.tracks.filter { tracksWithStops.contains($0.id) }

        // `buildTrackMap` reserves a lane for a spoor's STOP span only — never
        // for the row it branches from or merges into — so two sporen that never
        // ran at the same time can share a lane with one's connector having to
        // pass the other. Every extent starts as that span; a connector may
        // stretch it only through rows its lane holds for nobody else.
        var extents = drawn.map { Extent(trackId: $0.id, lane: $0.lane, isRoot: $0.isRoot,
                                         top: $0.firstRow, bottom: $0.lastRow) }
        var curvesAt: [Int: [Curve]] = [:]
        var capsAt: [Int: [Cap]] = [:]
        var detourSpans: [DetourSpan] = []
        // Where a connector replaces the spoor's own slice of rail.
        var cutTop: Set<Slice> = [], cutBottom: Set<Slice> = []

        /// Can a rail in `lane` run from row `edge` (the spoor's end) to the
        /// connector row `at`? Not if another spoor holds the lane in any row
        /// between them, or passes straight through the connector row. Ending
        /// AT the connector row is fine: that is an interchange — one spoor
        /// merging into the stop another branches from — and both slices there
        /// are already replaced by their curves.
        func laneIsFree(_ lane: Int, from edge: Int, to at: Int, except id: String) -> Bool {
            let lo = min(edge, at) + 1, hi = max(edge, at) - 1
            return !extents.contains { e in
                e.trackId != id && e.lane == lane
                    && ((lo <= hi && e.top <= hi && lo <= e.bottom) || (e.top < at && at < e.bottom))
            }
        }
        func curve(_ row: Int, _ c: Curve) { curvesAt[row, default: []].append(c) }

        if singleLane {
            // One rail from the newest stop to the oldest; the words carry the rest.
            if let lo = map.stops.map(\.row).min(), let hi = map.stops.map(\.row).max() {
                let rootId = map.tracks.first(where: \.isRoot)?.id ?? "root"
                extents = [Extent(trackId: rootId, lane: 0, isRoot: true, top: lo, bottom: hi)]
            } else {
                extents = []
            }
        } else {
            for (i, t) in drawn.enumerated() {
                let span = (top: t.firstRow, bottom: t.lastRow)
                var anchored = t.isRoot
                for edge in map.edges where edge.trackId == t.id {
                    let lane = t.lane
                    switch edge.kind {
                    case "branch":
                        if edge.fromRow > span.bottom {
                            anchored = true
                            // The trigger is OLDER than the spoor: the line rises from it.
                            if laneIsFree(lane, from: extents[i].bottom, to: edge.fromRow, except: t.id) {
                                extents[i].bottom = edge.fromRow
                                cutTop.insert(Slice(row: edge.fromRow, trackId: t.id))
                                curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                          edgeLane: lane, edge: .top))
                            } else {
                                curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                          edgeLane: lane, edge: .top, via: true))
                                curve(span.bottom, Curve(kind: .branch, trackId: t.id, centerLane: lane,
                                                         edgeLane: lane, edge: .bottom, via: true))
                                detourSpans.append(DetourSpan(trackId: t.id, lane: lane, top: span.bottom,
                                                              bottom: edge.fromRow))
                            }
                        } else if edge.fromRow == edge.toRow && edge.fromLane != edge.toLane {
                            // No recorded branch stop: the spoor begins with a cap.
                        } else if edge.fromRow < span.top {
                            anchored = true
                            // The trigger is NEWER than all of the spoor (logged after its
                            // first step). `buildTrackMap` still rings the junction, so the
                            // line leaves the ring DOWNWARD and reaches the spoor's newest stop.
                            if laneIsFree(lane, from: extents[i].top, to: edge.fromRow, except: t.id) {
                                extents[i].top = min(extents[i].top, edge.fromRow)
                                cutBottom.insert(Slice(row: edge.fromRow, trackId: t.id))
                                curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                          edgeLane: lane, edge: .bottom))
                            } else {
                                curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                          edgeLane: lane, edge: .bottom, via: true))
                                curve(span.top, Curve(kind: .branch, trackId: t.id, centerLane: lane,
                                                      edgeLane: lane, edge: .top, via: true))
                                detourSpans.append(DetourSpan(trackId: t.id, lane: lane, top: edge.fromRow,
                                                              bottom: span.top))
                            }
                        } else if edge.fromRow > span.top && edge.fromRow < span.bottom && edge.fromLane != lane {
                            anchored = true
                            // The trigger sits INSIDE the spoor's span: the spoor really
                            // passes this row, so its rail stays whole and the line
                            // leaves the ring beside it, down into the spoor's lane.
                            curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                      edgeLane: lane, edge: .bottom))
                        }
                    case "merge":
                        guard edge.toRow < span.top else { break }
                        if laneIsFree(lane, from: extents[i].top, to: edge.toRow, except: t.id) {
                            extents[i].top = min(extents[i].top, edge.toRow)
                            cutBottom.insert(Slice(row: edge.toRow, trackId: t.id))
                            curve(edge.toRow, Curve(kind: .merge, trackId: t.id, centerLane: edge.toLane,
                                                    edgeLane: lane, edge: .bottom))
                        } else {
                            curve(span.top, Curve(kind: .merge, trackId: t.id, centerLane: lane,
                                                  edgeLane: lane, edge: .top, via: true))
                            curve(edge.toRow, Curve(kind: .merge, trackId: t.id, centerLane: edge.toLane,
                                                    edgeLane: lane, edge: .bottom, via: true))
                            detourSpans.append(DetourSpan(trackId: t.id, lane: lane, top: edge.toRow, bottom: span.top))
                        }
                    default: break
                    }
                }
                // Where a line starts without a connector: the hoofdlijn's oldest
                // stop, and a spoor with no recorded branch stop.
                if !anchored || t.isRoot { capsAt[span.bottom, default: []].append(Cap(lane: t.lane, end: .bottom)) }
                if !t.isRoot, t.terminus == "done" || t.terminus == "ended" {
                    capsAt[span.top, default: []].append(Cap(lane: t.lane, end: .top))
                }
            }

            // A running spoor with no open stop is drawn on towards now, dashed,
            // through every row above it that its lane holds for nobody else.
            let openTracks = Set(map.stops.filter { $0.state == "open" }.map(\.trackId))
            func free(_ lane: Int, _ row: Int, except id: String) -> Bool {
                !extents.contains { $0.trackId != id && $0.lane == lane && $0.top <= row && row <= $0.bottom }
                    && !detourSpans.contains { $0.lane == lane && $0.top < row && row < $0.bottom }
                    && !(curvesAt[row] ?? []).contains { $0.trackId != id && ($0.edgeLane == lane || $0.centerLane == lane) }
            }
            for (i, t) in drawn.enumerated() where !t.isRoot && t.terminus == "open" && !openTracks.contains(t.id) {
                let newest = extents[i].top
                guard newest == t.firstRow, newest > 0 else { continue }
                var target = newest
                while target > 0 && free(t.lane, target - 1, except: t.id) { target -= 1 }
                if target < newest {
                    extents[i].top = target
                    extents[i].dashedBelow = newest
                } else {
                    extents[i].stub = newest
                }
            }
        }

        func sorted(_ rails: [Rail]) -> [Rail] { rails.sorted { ($0.lane, $0.trackId) < ($1.lane, $1.trackId) } }
        func sorted(_ ds: [Detour]) -> [Detour] { ds.sorted { ($0.lane, $0.trackId) < ($1.lane, $1.trackId) } }

        func rails(atRow r: Int) -> [Rail] {
            sorted(extents.compactMap { e -> Rail? in
                let stubbed = e.stub == r
                let top = (r > e.top && r <= e.bottom && !cutTop.contains(Slice(row: r, trackId: e.trackId))) || stubbed
                let bottom = r >= e.top && r < e.bottom && !cutBottom.contains(Slice(row: r, trackId: e.trackId))
                guard top || bottom else { return nil }
                let dashedTop = stubbed || e.dashedBelow.map { r <= $0 } ?? false
                let dashedBottom = e.dashedBelow.map { r < $0 } ?? false
                return Rail(lane: e.lane, trackId: e.trackId, isRoot: e.isRoot, top: top, bottom: bottom,
                            dashedTop: top && dashedTop, dashedBottom: bottom && dashedBottom)
            })
        }

        /// The rails crossing the boundary just above row `r`.
        func rails(above r: Int) -> [Rail] {
            sorted(extents.filter { $0.top < r && r <= $0.bottom }
                .map { e in
                    let dashed = e.dashedBelow.map { r <= $0 } ?? false
                    return Rail(lane: e.lane, trackId: e.trackId, isRoot: e.isRoot, top: true, bottom: true,
                                dashedTop: dashed, dashedBottom: dashed)
                })
        }

        func detours(atRow r: Int) -> [Detour] {
            sorted(detourSpans.filter { $0.top < r && r < $0.bottom }.map { Detour(lane: $0.lane, trackId: $0.trackId) })
        }

        func detours(above r: Int) -> [Detour] {
            sorted(detourSpans.filter { $0.top < r && r <= $0.bottom }.map { Detour(lane: $0.lane, trackId: $0.trackId) })
        }

        let words = Words(map)
        let byRow = map.stops.sorted { $0.row < $1.row }
        var items: [Item] = []
        for band in map.bands {
            let inBand = byRow.filter { $0.row >= band.fromRow && $0.row < band.toRow }
            items.append(.band(BandRow(key: band.key, label: words.bandLabel(band), empty: band.empty,
                                       rails: rails(above: band.fromRow), detours: detours(above: band.fromRow),
                                       labelHidden: band.key == "nu" && !inBand.isEmpty)))
            for s in inBand {
                let track = trackById[s.trackId]
                let mark: Mark = s.id == map.currentStopId ? .current : s.state == "open" ? .open : .done
                items.append(.stop(StopRow(stop: s, track: track, mark: mark, lane: singleLane ? 0 : s.lane,
                                           readouts: words.readouts(s, track: track, mark: mark),
                                           sentences: words.sentences(s, track: track, mark: mark),
                                           rails: rails(atRow: s.row), curves: curvesAt[s.row] ?? [],
                                           caps: capsAt[s.row] ?? [], detours: detours(atRow: s.row))))
            }
        }
        self.items = items
    }

    /// The readouts and sentences of every row, from the map alone.
    struct Words {
        let map: CaseMapDTO
        let trackById: [String: CaseMapDTO.Track]
        /// The year of the newest dated stop: a date in it goes without its year.
        let year: Int?
        /// Sporen still running with no open stop — drawn dashed towards now.
        let running: [CaseMapDTO.Track]

        static var amsterdam: Calendar {
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
            return cal
        }

        init(_ map: CaseMapDTO) {
            self.map = map
            trackById = Dictionary(map.tracks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            year = map.stops.compactMap(\.happenedAt).max().map { Self.amsterdam.component(.year, from: $0) }
            let open = Set(map.stops.filter { $0.state == "open" }.map(\.trackId))
            let withStops = Set(map.stops.map(\.trackId))
            running = map.tracks.filter { !$0.isRoot && $0.terminus == "open" && !open.contains($0.id)
                && withStops.contains($0.id) }
        }

        func day(_ d: Date) -> String {
            let y = Self.amsterdam.component(.year, from: d)
            return y == year ? MoneyFormat.day(d) : "\(MoneyFormat.day(d)) \(y)"
        }

        /// "Oktober" in the newest year, "Oktober 2025" before it.
        func bandLabel(_ band: CaseMapDTO.Band) -> String {
            switch band.key {
            case "nu": return "Nu"
            case "onbekend": return TimelineCopy.unknownBand
            default:
                let p = band.key.split(separator: "-").compactMap { Int($0) }
                guard p.count == 2, (1...12).contains(p[1]) else { return band.label }
                let name = MoneyFormat.monthsLong[p[1] - 1].capitalized
                return p[0] == year ? name : "\(name) \(p[0])"
            }
        }

        func stop(atRow row: Int, lane: Int) -> CaseMapDTO.Stop? {
            map.stops.first { $0.row == row && $0.lane == lane }
        }

        func isNewest(_ s: CaseMapDTO.Stop, of t: CaseMapDTO.Track) -> Bool { s.row == t.firstRow }
        func isOldest(_ s: CaseMapDTO.Stop, of t: CaseMapDTO.Track) -> Bool { s.row == t.lastRow }

        func mergeStop(_ t: CaseMapDTO.Track) -> CaseMapDTO.Stop? {
            guard let e = map.edges.first(where: { $0.trackId == t.id && $0.kind == "merge" }) else { return nil }
            return stop(atRow: e.toRow, lane: e.toLane)
        }

        /// A spoor's own branch stop on its parent, when the map recorded one.
        func branchStop(_ t: CaseMapDTO.Track) -> CaseMapDTO.Stop? {
            guard let e = map.edges.first(where: { $0.trackId == t.id && $0.kind == "branch" }),
                  !(e.fromRow == e.toRow && e.fromLane != e.toLane) else { return nil }
            return stop(atRow: e.fromRow, lane: e.fromLane)
        }

        func when(_ s: CaseMapDTO.Stop) -> String? {
            if let at = s.happenedAt { return day(at) }
            return s.bandKey == "nu" ? nil : "zonder datum"
        }

        func readouts(_ s: CaseMapDTO.Stop, track t: CaseMapDTO.Track?, mark: Mark) -> [Readout] {
            let spoor = (t?.isRoot ?? true) ? nil : t?.title
            switch mark {
            case .current:
                if let spoor { return [Readout(text: "spoor \(spoor)")] }
                // The spoor runs dashed up INTO the hero: "loopt hierheen", on
                // its own line, as the frame sets it.
                return running.map { Readout(text: "spoor \($0.title)\nloopt hierheen") }
            case .open:
                return [Readout(text: (["wacht op jou", when(s)].compactMap { $0 }).joined(separator: " · "), tone: .attn)]
                    + (spoor.map { [Readout(text: $0)] } ?? [])
            case .done:
                var prefix: String?
                var tail: Readout?
                if let t, !t.isRoot, isNewest(s, of: t) {
                    switch t.terminus {
                    case "ended": prefix = "afgehandeld"
                    case "done": prefix = "afgerond"
                    case "merge":
                        let back = mergeStop(t)?.happenedAt.map { "terug op \(day($0))" } ?? "terug op de hoofdlijn"
                        tail = Readout(text: "laatste halte · \(back)")
                    default: break
                    }
                }
                let line = [prefix, when(s), spoor].compactMap { $0 }.joined(separator: " · ")
                return (line.isEmpty ? [] : [Readout(text: line)]) + (tail.map { [$0] } ?? [])
            }
        }

        /// One paragraph per fact, sentence case, every spoor named.
        func sentences(_ s: CaseMapDTO.Stop, track t: CaseMapDTO.Track?, mark: Mark) -> [String] {
            var out: [String] = []
            let side = (t?.isRoot ?? true) ? nil : t
            if let at = s.happenedAt { out.append(day(at)) }
            else { out.append(s.bandKey == "nu" ? "Nu · zonder datum" : "Zonder datum") }
            if mark == .open { out.append("Wacht op jou.") }
            if let side { out.append("Spoor \(side.title)") }
            if mark == .current, side == nil {
                out += running.map { "Spoor \($0.title) loopt hierheen." }
            }
            if let t, t.isRoot, isOldest(s, of: t) { out.append("De hoofdlijn begint hier.") }
            if let side, isOldest(s, of: side), branchStop(side) == nil { out.append("Hier begint dit spoor.") }
            for e in map.edges where e.kind == "merge" && e.toRow == s.row && e.toLane == s.lane {
                if let other = trackById[e.trackId] { out.append("Spoor \(other.title) komt hier terug.") }
            }
            for e in map.edges where e.kind == "branch" && e.fromRow == s.row && e.fromLane == s.lane
                && e.trackId != s.trackId && !(e.fromRow == e.toRow && e.fromLane != e.toLane) {
                if let other = trackById[e.trackId] { out.append("Spoor \(other.title) splitst hier af.") }
            }
            if let side, isNewest(s, of: side), mark == .done {
                switch side.terminus {
                case "ended": out.append("Afgehandeld.")
                case "done": out.append("Afgerond.")
                case "merge":
                    if let at = mergeStop(side)?.happenedAt {
                        out.append("Laatste halte. Terug op de hoofdlijn op \(day(at)).")
                    } else {
                        out.append("Laatste halte. Terug op de hoofdlijn.")
                    }
                default: break
                }
            }
            if s.datesOutOfOrder { out.append("Let op: \(TimelineCopy.flagged).") }
            return out
        }
    }
}
