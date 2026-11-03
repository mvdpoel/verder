import Foundation
import Observation

/// Where a tapped notification leads, parsed from the push payload's `link`
/// (`verder://proposal/<uuid>`, `verder://suggestion/<uuid>`,
/// `verder://task/<uuid>`, `verder://document/<uuid>`, `verder://inbox`,
/// `verder://weekly`, `verder://voice`, `verder://done-by-verder`,
/// `verder://dossier`, `verder://timeline`, `verder://overzicht`, `verder://money`).
///
/// EVERY CASE BUT `.none` HAS A `destination` — a tab, a stack or the voice
/// sheet — and `LinkDestinationTests` checks that every link the worker and
/// the web can send parses to one, so no tap ever lands nowhere.
///
/// The payload comes off the wire, so the parse is strict: exactly the scheme,
/// a known host, no user, port, query or fragment, and exactly one UUID path
/// segment where one is expected. Anything else is `.none` — never a crash,
/// never a guess. The app registers NO `verder://` URL scheme: these links
/// arrive only inside a push, or from verder's own widget (`widgetURL`, which
/// reaches `RootView.onOpenURL` without a registered scheme), so no web page
/// or other app can fire one.
enum DeepLink: Equatable, Sendable {
    case proposal(UUID)
    case suggestion(UUID)
    case task(UUID)
    case document(UUID)
    case inbox
    /// `verder://voice`: the voice quick-log (the home screen quick action,
    /// plan 3 Task 25). A sheet over whatever tab is showing, never a tab.
    case voice
    /// `verder://weekly`: the Weekoverzicht (plan 3 Task 26), on Meer. The
    /// Sunday push itself carries `verder://inbox`; `NotificationRouter`
    /// sends a tap on its `WEEKLY` category here.
    case weekly
    /// `verder://done-by-verder`: "Door verder gedaan" on Voor jou — what
    /// verder filed or renamed by itself (Overzicht's card, the daily digest).
    case doneByVerder
    /// `verder://dossier`: the Dossier tab at its root (a link-less filing
    /// push: a merged duplex scan, a new loonstrook).
    case dossier
    /// `verder://timeline`: the Tijdlijn (the case map) on Dossier.
    case timeline
    /// `verder://overzicht`: the Overzicht tab (a link-less system push).
    case overzicht
    /// `verder://money`: Geld, on Meer.
    case money
    /// `verder://scan`: the camera on Scan, at once — the home screen quick
    /// action, the Control Center control and the Action button (R20). Scan
    /// is not lock-gated, so it opens without Face ID.
    case scan
    case none

    init(userInfo: [AnyHashable: Any]) {
        guard let link = userInfo["link"] as? String else { self = .none; return }
        self = Self.parse(link)
    }

    static func parse(_ link: String) -> DeepLink {
        guard let parts = URLComponents(string: link),
              parts.scheme == "verder",
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil,
              let host = parts.host
        else { return .none }
        let segments = parts.path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        // "" → [""], "/x" → ["", "x"]
        switch host {
        case "inbox":
            return parts.path.isEmpty ? .inbox : .none
        case "voice":
            return parts.path.isEmpty ? .voice : .none
        case "weekly":
            return parts.path.isEmpty ? .weekly : .none
        case "done-by-verder":
            return parts.path.isEmpty ? .doneByVerder : .none
        case "dossier":
            return parts.path.isEmpty ? .dossier : .none
        case "timeline":
            return parts.path.isEmpty ? .timeline : .none
        case "overzicht":
            return parts.path.isEmpty ? .overzicht : .none
        case "money":
            return parts.path.isEmpty ? .money : .none
        case "scan":
            return parts.path.isEmpty ? .scan : .none
        case "proposal", "suggestion", "task", "document":
            guard segments.count == 2, segments[0].isEmpty, let id = UUID(uuidString: segments[1]) else { return .none }
            switch host {
            case "proposal": return .proposal(id)
            case "suggestion": return .suggestion(id)
            case "task": return .task(id)
            default: return .document(id)
            }
        default:
            return .none
        }
    }

    /// The tab a link opens: the destination's, so the two cannot disagree.
    /// Voor jou, Dossier and Meer are lock-gated, so whatever the link points
    /// at is shown only after unlock.
    var tab: RootView.TabID? { destination?.tab }

    /// Where the link lands; nil only for `.none`. A proposal, suggestion or
    /// task opens Voor jou with that item on top; a document opens the viewer
    /// on Dossier; the Weekoverzicht and Geld open on Meer.
    var destination: LinkDestination? {
        switch self {
        case .proposal(let id): LinkDestination(tab: .voorJou, stack: .inbox([.proposal(id.lowerString)]))
        case .suggestion(let id): LinkDestination(tab: .voorJou, stack: .inbox([.suggestion(id.lowerString)]))
        case .task(let id): LinkDestination(tab: .voorJou, stack: .inbox([.task(id.lowerString)]))
        case .inbox: LinkDestination(tab: .voorJou, stack: .inbox([]))
        case .doneByVerder: LinkDestination(tab: .voorJou, stack: .inbox([.doneByVerder]))
        case .document(let id): LinkDestination(tab: .dossier, stack: .dossier([.document(id: id.lowerString, title: nil)]))
        case .dossier: LinkDestination(tab: .dossier, stack: .dossier([]))
        case .timeline: LinkDestination(tab: .dossier, stack: .dossier([.timeline]))
        case .overzicht: LinkDestination(tab: .home, stack: nil)
        case .weekly: LinkDestination(tab: .meer, stack: .meer([.weekly]))
        case .money: LinkDestination(tab: .meer, stack: .meer([.money]))
        case .voice: LinkDestination(tab: nil, stack: nil, opensVoice: true)
        case .scan: LinkDestination(tab: .scan, stack: nil, opensCamera: true)
        case .none: nil
        }
    }
}

/// Where a `DeepLink` lands, decided outside RootView so a test can see it:
/// the tab, the stack that tab shows (replacing whatever was there), and
/// whether the voice sheet opens over the current tab.
struct LinkDestination: Equatable, Sendable {
    enum Stack: Equatable, Sendable {
        case inbox([InboxRoute])
        case dossier([DossierRoute])
        case meer([MoreRoute])
    }

    let tab: RootView.TabID?
    let stack: Stack?
    var opensVoice = false
    /// Scan's camera opens straight away (no tap on the disc).
    var opensCamera = false
}

private extension UUID {
    /// Ids travel to the server lowercased, as the routes print them.
    var lowerString: String { uuidString.lowercased() }
}

/// The hand-off from the notification delegate to the screens. A tap on a
/// notification can launch the app cold, before any view exists, so the link
/// waits here until `RootView` takes it.
@MainActor
@Observable
final class DeepLinkInbox {
    private(set) var pending: DeepLink = .none

    func deliver(_ link: DeepLink) {
        guard link != .none else { return }
        pending = link
    }

    /// Returns the waiting link once and clears it.
    func take() -> DeepLink {
        defer { pending = .none }
        return pending
    }
}
