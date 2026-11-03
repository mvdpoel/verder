#if DEBUG
import Foundation

/// The launch arguments that run the app on the synthetic dataset, for
/// screenshots (`scripts/capture.sh`) and for designing against the Figma
/// frames. DEBUG ONLY — see `FixtureServer`.
///
///     -fixtures <name>         answer every /api/mobile/v1 call from FixtureData/<name>
///     -fixtures-locked         keep the app lock closed: Overzicht's counts-only glance
///     -fixtures-scans          the phone's queue holds today's scans: 2 sent, 1 waiting
///     -fixtures-queue <preset> the Scan tab's queue as a "scan · final" frame draws it
///                              (`QueuePreset`; its own clock, 1 nov in the afternoon)
///     -fixtures-camera <notDetermined|denied>  the camera permission (default: allowed)
///     -fixtures-scan <handoff|queue|note|preprompt>  open Scan on a state only a gesture reaches
///     -fixtures-scroll <waiting|leefgeld|rest|end>  open Overzicht scrolled to that card (the rest of a "hele pagina" frame)
///     -fixtures-geld <open|nov|sep|sheet>  push Geld from Overzicht (as a card tap does): as it opens, with
///                              the "maand gekozen" months selected, or with the beheerrekening's sheet up
///     -fixtures-faceid idle    with -fixtures-locked: the glance before any answer — the automatic
///                              prompt counted as asked, nothing cancelled ("Toon details" and its footnote)
///     -fixtures-faceid asking  with -fixtures-locked: the automatic Face ID prompt never answers,
///                              so Overzicht holds its "vraagt" state (no button)
///     -fixtures-push <denied|notDetermined>  the notification permission (default: allowed)
///     -fixtures-more <signout|savefail>  a Meer screen in a state only a gesture reaches: the
///                              Uitloggen sheet up (Account), or a Meldingen switch whose save failed
///     -fixtures-timeline <state[,state…]>  the Tijdlijn in a state only a gesture reaches:
///                              verborgen (Schuldeisers verbergen on) · sheet (the NU sheet up) ·
///                              scroll:<stop id> (that stop at the top) · stop:<stop id> (its sheet up) ·
///                              end (the legend) · overzicht (pushed from Overzicht's headline card)
///     -tab <overzicht|voorjou|scan|dossier|meer>
///     -route <proposal:<id>|suggestion:<id>|task:<id>|document:<id>|geld|weekly|timeline|voice
///             |meer:<account|notifications|widgets|about|developer>>
///
/// Without `-fixtures` none of the others does anything: a DEBUG build on the
/// real server never jumps tabs because of a stale scheme argument.
struct FixtureLaunch: Equatable, Sendable {
    enum Tab: String, CaseIterable, Sendable {
        case overzicht, voorjou, scan, dossier, meer

        var tabID: RootView.TabID {
            switch self {
            case .overzicht: .home
            case .voorjou: .voorJou
            case .scan: .scan
            case .dossier: .dossier
            case .meer: .meer
            }
        }
    }

    enum Route: Equatable, Sendable {
        /// Delivered through `DeepLinkInbox`, the path a notification tap takes.
        case link(DeepLink)
        /// A screen a link cannot show in its capture state: the voice log
        /// already recorded and transcribed (`FixtureScreen`).
        case screen(Screen)
        /// A Meer screen, pushed onto the Meer stack as its row's tap does.
        case meer([MoreRoute])
    }

    /// Meer states only a gesture reaches (`-fixtures-more`).
    enum MoreState: String, CaseIterable, Sendable {
        case signOut = "signout"
        case saveFail = "savefail"
    }

    enum Screen: String, CaseIterable, Identifiable, Sendable {
        case voice
        var id: String { rawValue }
    }

    /// The Scan tab's queue, one per "scan · final" frame (FixtureEnvironment).
    enum QueuePreset: String, CaseIterable, Sendable {
        /// Nothing ever scanned: "Nog geen scans".
        case first
        /// "1 in de wachtrij": 14:32 on its way, two minutes ago.
        case underway
        /// "wachtrij leeg": three sent today, nothing waiting.
        case done
        /// Three waiting for the network.
        case offline
        /// 11:05 failed, 14:32 on its way, nine sent ("mislukt", "Wachtrij / veel").
        case failed
        /// `failed`, two minutes after the 14:32 capture (AX5 · mislukt).
        case failedRecent = "failed-recent"
        /// Two held for a sign-in ("log opnieuw in").
        case signin
        /// `signin`, minutes after the newest capture (AX5 · log opnieuw in).
        case signinRecent = "signin-recent"
    }

    enum ScanState: String, CaseIterable, Sendable { case handoff, queue, note, preprompt }

    /// Geld pushed from Overzicht, in one of the "money · final" Geld states.
    enum GeldState: String, CaseIterable, Sendable { case open, nov, sep, sheet }

    /// The moment of the Face ID prompt a locked capture holds.
    enum FaceIDState: String, CaseIterable, Sendable { case asking, idle }

    /// Overzicht's cards a capture can scroll to (`HomeTab`'s scroll ids).
    /// `middle` is a Meer screen's own middle anchor (`MorePageAnchor`).
    enum Scroll: String, CaseIterable, Sendable { case waiting, leefgeld, rest, end, middle }

    /// The Tijdlijn's gesture-only states (`-fixtures-timeline`).
    enum TimelineState: Equatable, Sendable {
        case verborgen, sheet, end, overzicht, dicht
        case scroll(String)
        case stop(String)

        static func parse(_ raw: String) -> TimelineState? {
            switch raw {
            case "verborgen": return .verborgen
            case "sheet": return .sheet
            case "end": return .end
            case "overzicht": return .overzicht
            case "dicht": return .dicht
            default:
                if raw.hasPrefix("scroll:") { return .scroll(String(raw.dropFirst("scroll:".count))) }
                if raw.hasPrefix("stop:") { return .stop(String(raw.dropFirst("stop:".count))) }
                return nil
            }
        }
    }

    enum ParseError: Error, Equatable {
        case unknownScroll(String)
        case missingValue(String)
        case unknownTab(String)
        case unknownRoute(String)
        case unknownValue(String, String)
    }

    let fixture: String
    let locked: Bool
    let tab: Tab?
    let route: Route?
    /// Where Overzicht opens scrolled to; nil for the top.
    var scroll: Scroll? = nil
    var scans = false
    var queue: QueuePreset? = nil
    var camera: CameraAuthorization? = nil
    var scanState: ScanState? = nil
    var geld: GeldState? = nil
    var faceID: FaceIDState? = nil
    var push: PushPermission? = nil
    var more: MoreState? = nil
    var timeline: [TimelineState] = []

    /// Nil without `-fixtures`. Throws on a value it cannot read, so a typo in
    /// a capture script fails loudly instead of screenshotting the wrong tab.
    static func parse(_ arguments: [String]) throws(ParseError) -> FixtureLaunch? {
        func value(after flag: String) throws(ParseError) -> String? {
            guard let i = arguments.firstIndex(of: flag) else { return nil }
            let next = arguments.index(after: i)
            guard next < arguments.endIndex, !arguments[next].hasPrefix("-") else { throw .missingValue(flag) }
            return arguments[next]
        }
        guard let fixture = try value(after: "-fixtures") else { return nil }
        let tab = try value(after: "-tab").map { (raw: String) throws(ParseError) -> Tab in
            guard let t = Tab(rawValue: raw) else { throw .unknownTab(raw) }
            return t
        }
        let route = try value(after: "-route").map { (raw: String) throws(ParseError) -> Route in
            try parseRoute(raw)
        }
        return FixtureLaunch(fixture: fixture, locked: arguments.contains("-fixtures-locked"), tab: tab, route: route,
                             scroll: try value(after: "-fixtures-scroll").map { (raw: String) throws(ParseError) -> Scroll in
                                 guard let s = Scroll(rawValue: raw) else { throw .unknownScroll(raw) }
                                 return s
                             },
                             scans: arguments.contains("-fixtures-scans"),
                             queue: try value(after: "-fixtures-queue").map { (raw: String) throws(ParseError) -> QueuePreset in
                                 guard let q = QueuePreset(rawValue: raw) else { throw .unknownValue("-fixtures-queue", raw) }
                                 return q
                             },
                             camera: try value(after: "-fixtures-camera").map { (raw: String) throws(ParseError) -> CameraAuthorization in
                                 switch raw {
                                 case "notDetermined": return .notDetermined
                                 case "denied": return .denied
                                 case "authorized": return .authorized
                                 default: throw .unknownValue("-fixtures-camera", raw)
                                 }
                             },
                             scanState: try value(after: "-fixtures-scan").map { (raw: String) throws(ParseError) -> ScanState in
                                 guard let s = ScanState(rawValue: raw) else { throw .unknownValue("-fixtures-scan", raw) }
                                 return s
                             },
                             geld: try value(after: "-fixtures-geld").map { (raw: String) throws(ParseError) -> GeldState in
                                 guard let s = GeldState(rawValue: raw) else { throw .unknownValue("-fixtures-geld", raw) }
                                 return s
                             },
                             faceID: try value(after: "-fixtures-faceid").map { (raw: String) throws(ParseError) -> FaceIDState in
                                 guard let s = FaceIDState(rawValue: raw) else { throw .unknownValue("-fixtures-faceid", raw) }
                                 return s
                             },
                             push: try value(after: "-fixtures-push").map { (raw: String) throws(ParseError) -> PushPermission in
                                 switch raw {
                                 case "denied": return .denied
                                 case "notDetermined": return .notDetermined
                                 case "allowed": return .allowed
                                 default: throw .unknownValue("-fixtures-push", raw)
                                 }
                             },
                             more: try value(after: "-fixtures-more").map { (raw: String) throws(ParseError) -> MoreState in
                                 guard let s = MoreState(rawValue: raw) else { throw .unknownValue("-fixtures-more", raw) }
                                 return s
                             },
                             timeline: try (value(after: "-fixtures-timeline") ?? "").split(separator: ",")
                                 .map { (raw: Substring) throws(ParseError) -> TimelineState in
                                     guard let s = TimelineState.parse(String(raw)) else {
                                         throw .unknownValue("-fixtures-timeline", String(raw))
                                     }
                                     return s
                                 })
    }

    /// `proposal:<uuid>` and friends go through `DeepLink.parse`, the strict
    /// parser a notification's link goes through — so a fixture route opens a
    /// screen exactly the way a real tap would.
    static func parseRoute(_ raw: String) throws(ParseError) -> Route {
        if let screen = Screen(rawValue: raw) { return .screen(screen) }
        // The Weekoverzicht and Geld have links of their own (a tap on the
        // Sunday push; `verder://money`), so a capture takes the tap's path.
        if raw == "weekly" { return .link(.weekly) }
        if raw == "geld" { return .link(.money) }
        if raw == "timeline" { return .link(.timeline) }
        if raw.hasPrefix("meer:") {
            switch raw.dropFirst("meer:".count) {
            case "account": return .meer([.account])
            case "notifications": return .meer([.notifications])
            case "widgets": return .meer([.widgets])
            case "about": return .meer([.about])
            case "developer": return .meer([.about, .developer])
            default: throw .unknownRoute(raw)
            }
        }
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, ["proposal", "suggestion", "task", "document"].contains(parts[0]) else {
            throw .unknownRoute(raw)
        }
        let link = DeepLink.parse("verder://\(parts[0])/\(parts[1])")
        guard link != .none else { throw .unknownRoute(raw) }
        return .link(link)
    }

    /// This process's launch, read once.
    static let current: FixtureLaunch? = {
        do {
            return try parse(ProcessInfo.processInfo.arguments)
        } catch {
            fatalError("fixtures: cannot read the launch arguments: \(error)")
        }
    }()
}
#endif
