#if DEBUG
import Foundation

/// The launch arguments that run the app on the synthetic dataset, for
/// screenshots (`scripts/capture.sh`) and for designing against the Figma
/// frames. DEBUG ONLY — see `FixtureServer`.
///
///     -fixtures <name>         answer every /api/mobile/v1 call from FixtureData/<name>
///     -fixtures-locked         keep the app lock closed: Overzicht's counts-only glance
///     -tab <overzicht|voorjou|scan|dossier|meer>
///     -route <proposal:<id>|suggestion:<id>|task:<id>|document:<id>|geld|weekly|voice>
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
    }

    enum Screen: String, CaseIterable, Identifiable, Sendable {
        case voice
        var id: String { rawValue }
    }

    enum ParseError: Error, Equatable {
        case missingValue(String)
        case unknownTab(String)
        case unknownRoute(String)
    }

    let fixture: String
    let locked: Bool
    let tab: Tab?
    let route: Route?

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
        return FixtureLaunch(fixture: fixture, locked: arguments.contains("-fixtures-locked"), tab: tab, route: route)
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
