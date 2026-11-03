import CoreGraphics
import Foundation

/// The words of the Tijdlijn, decided outside the view.
enum TimelineCopy {
    static let title = "De zaak"
    static let rowTitle = "Tijdlijn"
    static let rowLine = "De zaak, het nieuwste bovenaan"
    static let intro = "Het nieuwste staat bovenaan. De hoofdlijn is hoe de bewindvoering zelf is gelopen; "
        + "een zijspoor begint zodra er iets binnenkomt en komt terug op de hoofdlijn of eindigt op zichzelf."
    static let headlineLabel = "WAAR HET NU OP WACHT"
    static let noHeadline = "Er staat op dit moment geen halte open."
    static let mapLabel = "DE KAART"
    static let problemsLabel = "WAT DE KAART NIET KON TEKENEN"
    static let hideDebts = "Schuldeisers verbergen"
    static let empty = "Er staat nog niets op de kaart. Zodra er een halte is, staat hij hier."
    static let offlineNothing = "Geen verbinding — de tijdlijn staat nog niet op je telefoon."
    static let retry = "Opnieuw proberen"
    static let quietMonth = "geen haltes"
    static let legend = "Gevuld = gebeurd · amber = wacht op jou · omcirkeld = vertrek- of aankomstpunt van een "
        + "zijspoor · dubbele streep = spoor afgerond · enkele streep = spoor geëindigd. "
        + "Binnen een maand staan de haltes op volgorde, niet op schaal."
    static let outOfOrder = "De datum van deze halte ligt vóór de halte ervoor. De kaart tekent de volgorde zoals hij is "
        + "ingevoerd — meestal betekent dit dat deze halte op een ander spoor thuishoort."
    static let nothingBehind = "Nog niets achter deze halte. Zodra er een mail, een taak of een document aan hangt, staat het hier."
    static let close = "Sluiten"

    static func hiddenCount(_ n: Int) -> String { n == 1 ? "1 spoor verborgen" : "\(n) sporen verborgen" }

    /// The spoor's status in words. `ended` is geëindigd — handled and closed,
    /// a clean outcome — and is never worded as a failure.
    static func trackStatus(_ status: String) -> String {
        switch status {
        case "done": "afgerond"
        case "ended": "geëindigd"
        default: "loopt nog"
        }
    }

    /// How a spoor finishes, for the stop sheet.
    static func terminus(_ track: CaseMapDTO.Track) -> String {
        if track.isRoot { return "hoofdlijn" }
        if track.terminus == "merge" { return "komt terug op de hoofdlijn" }
        return "eindigt op zichzelf"
    }

    static func stopState(_ state: String) -> String { state == "open" ? "wacht op jou" : "gebeurd" }

    @MainActor static func taskStatus(_ status: String) -> String { TaskModel.label(status) }
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
/// to its oldest stop. When the branch stop is newer than the spoor's oldest
/// stop, the curve goes DOWN into the spoor's lane instead and the rail runs
/// up to meet it. A merge comes down the spoor's lane and curves into the
/// parent's dot at the merge stop.
struct TimelineLayout: Equatable {
    /// Lane x positions in the gutter left of the labels. Up to four lanes sit
    /// at a fixed spacing; more squeeze into the same four-lane width, so the
    /// label column on a 375 pt phone never narrows past it.
    struct Lanes: Equatable {
        static let baseSpacing: CGFloat = 16
        static let inset: CGFloat = 12
        static let maxVisible = 4

        let count: Int
        let spacing: CGFloat

        init(count: Int) {
            self.count = count
            spacing = count <= Self.maxVisible
                ? Self.baseSpacing
                : Self.baseSpacing * CGFloat(Self.maxVisible - 1) / CGFloat(count - 1)
        }

        func x(_ lane: Int) -> CGFloat { Self.inset + CGFloat(lane) * spacing }

        var width: CGFloat {
            let visible = min(max(count, 1), Self.maxVisible)
            return 2 * Self.inset + CGFloat(visible - 1) * Self.baseSpacing
        }
    }

    /// A lane's slice of rail in one row: above the dot, below it, or both.
    struct Rail: Equatable, Hashable, Sendable {
        let lane: Int
        let trackId: String
        let isRoot: Bool
        let top: Bool
        let bottom: Bool
    }

    enum CurveEdge: Equatable, Sendable {
        /// Rises from the dot to the top of the row (a branch, the spoor above).
        case top
        /// Comes from the bottom of the row into the dot (a merge, the spoor below).
        case bottom
        /// Level with the dot: a spoor with no recorded branch stop, drawn at its oldest stop.
        case level
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
    }

    /// The cap at a spoor's newest stop: afgerond and geëindigd are different
    /// facts, and BOTH are clean outcomes.
    struct Cap: Equatable, Sendable {
        enum Kind: Equatable, Sendable { case done, ended }
        let lane: Int
        let kind: Kind
    }

    enum Mark: Equatable, Sendable {
        /// The one stop the map answers with: what is waiting on Martin now.
        case current
        /// Another open stop — also work waiting on Martin.
        case waiting
        /// It happened.
        case done

        /// Amber is for open stops only: by the case-history rule every open
        /// stop is work waiting on Martin.
        var isAmber: Bool { self != .done }
    }

    struct BandRow: Equatable, Identifiable {
        let key: String
        let label: String
        let empty: Bool
        let rails: [Rail]
        var id: String { "band:" + key }
    }

    struct StopRow: Equatable, Identifiable {
        let stop: CaseMapDTO.Stop
        let track: CaseMapDTO.Track?
        let mark: Mark
        /// "hoofdlijn · 14 okt 2026" or "Opstart en stukken · loopt nu · wacht op jou".
        let meta: String
        let rails: [Rail]
        let curves: [Curve]
        let caps: [Cap]
        var id: String { stop.id }
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
    }

    init(_ map: CaseMapDTO) {
        lanes = Lanes(count: map.laneCount)
        let trackById = Dictionary(map.tracks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let tracksWithStops = Set(map.stops.map(\.trackId))

        var extents: [Extent] = []
        var curvesAt: [Int: [Curve]] = [:]
        for t in map.tracks where tracksWithStops.contains(t.id) {
            var e = Extent(trackId: t.id, lane: t.lane, isRoot: t.isRoot, top: t.firstRow, bottom: t.lastRow)
            for edge in map.edges where edge.trackId == t.id {
                switch edge.kind {
                case "branch":
                    if edge.fromRow > e.bottom {
                        e.bottom = edge.fromRow
                        curvesAt[edge.fromRow, default: []].append(Curve(
                            kind: .branch, trackId: t.id, centerLane: edge.fromLane, edgeLane: edge.toLane, edge: .top))
                    } else if edge.fromRow == edge.toRow && edge.fromLane != edge.toLane {
                        curvesAt[edge.fromRow, default: []].append(Curve(
                            kind: .branch, trackId: t.id, centerLane: edge.fromLane, edgeLane: edge.toLane, edge: .level))
                    } else if edge.fromRow < e.bottom && edge.fromLane != edge.toLane {
                        // The branch stop is NEWER than the spoor's oldest stop — a
                        // trigger logged after the spoor's first step. `buildTrackMap`
                        // still emits the edge and rings the junction, so the line
                        // leaves the ring DOWNWARD into the spoor's lane, and the
                        // spoor's rail reaches up to it. A ring with no line out of
                        // it is the one thing the map must never draw.
                        e.top = min(e.top, edge.fromRow)
                        curvesAt[edge.fromRow, default: []].append(Curve(
                            kind: .branch, trackId: t.id, centerLane: edge.fromLane, edgeLane: edge.toLane, edge: .bottom))
                    }
                case "merge":
                    if edge.toRow < e.top {
                        e.top = edge.toRow
                        curvesAt[edge.toRow, default: []].append(Curve(
                            kind: .merge, trackId: t.id, centerLane: edge.toLane, edgeLane: edge.fromLane, edge: .bottom))
                    }
                default: break
                }
            }
            extents.append(e)
        }

        func rails(atRow r: Int) -> [Rail] {
            let curves = curvesAt[r] ?? []
            return extents.compactMap { e -> Rail? in
                var top = r > e.top && r <= e.bottom
                var bottom = r >= e.top && r < e.bottom
                // A connector in this row replaces the spoor's own slice there.
                if curves.contains(where: { $0.trackId == e.trackId && $0.edge == .top }) { top = false }
                if curves.contains(where: { $0.trackId == e.trackId && $0.edge == .bottom }) { bottom = false }
                guard top || bottom else { return nil }
                return Rail(lane: e.lane, trackId: e.trackId, isRoot: e.isRoot, top: top, bottom: bottom)
            }.sorted { ($0.lane, $0.trackId) < ($1.lane, $1.trackId) }
        }

        /// The rails crossing the boundary just above row `r`.
        func rails(above r: Int) -> [Rail] {
            extents.filter { $0.top < r && r <= $0.bottom }
                .map { Rail(lane: $0.lane, trackId: $0.trackId, isRoot: $0.isRoot, top: true, bottom: true) }
                .sorted { ($0.lane, $0.trackId) < ($1.lane, $1.trackId) }
        }

        let byRow = map.stops.sorted { $0.row < $1.row }
        var items: [Item] = []
        for band in map.bands {
            items.append(.band(BandRow(key: band.key, label: band.label, empty: band.empty,
                                       rails: rails(above: band.fromRow))))
            for s in byRow where s.row >= band.fromRow && s.row < band.toRow {
                let track = trackById[s.trackId]
                let spoor = (track?.isRoot ?? true) ? "hoofdlijn" : (track?.title ?? "hoofdlijn")
                let mark: Mark = s.id == map.currentStopId ? .current : s.state == "open" ? .waiting : .done
                var caps: [Cap] = []
                if let track, !track.isRoot, s.row == track.firstRow {
                    switch track.terminus {
                    case "done": caps.append(Cap(lane: track.lane, kind: .done))
                    case "ended": caps.append(Cap(lane: track.lane, kind: .ended))
                    default: break
                    }
                }
                items.append(.stop(StopRow(stop: s, track: track, mark: mark, meta: Self.meta(s, spoor: spoor),
                                           rails: rails(atRow: s.row), curves: curvesAt[s.row] ?? [], caps: caps)))
            }
        }
        self.items = items
    }

    /// Spoor, then when, then — for an open stop — who it waits on.
    static func meta(_ s: CaseMapDTO.Stop, spoor: String) -> String {
        let when: String = if let at = s.happenedAt {
            DossierCopy.day(at)
        } else if s.bandKey == "nu" {
            "loopt nu"
        } else {
            "zonder datum"
        }
        return ([spoor, when] + (s.state == "open" ? ["wacht op jou"] : [])).joined(separator: " · ")
    }
}
