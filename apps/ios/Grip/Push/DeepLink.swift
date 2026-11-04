import Foundation
import Observation

/// Where a tapped notification leads, parsed from the push payload's `link`
/// (`grip://proposal/<uuid>`, `grip://suggestion/<uuid>`,
/// `grip://task/<uuid>`, `grip://document/<uuid>`, `grip://inbox`,
/// `grip://weekly`, `grip://voice`, `grip://done-by-grip`,
/// `grip://dossier`, `grip://timeline`, `grip://overzicht`, `grip://money`,
/// `grip://call`).
///
/// EVERY CASE BUT `.none` HAS A `destination` — a tab, a stack or the voice
/// sheet — and `LinkDestinationTests` checks that every link the worker and
/// the web can send parses to one, so no tap ever lands nowhere.
///
/// The payload comes off the wire, so the parse is strict: exactly the scheme,
/// a known host, no user, port, query or fragment, and exactly one UUID path
/// segment where one is expected. Anything else is `.none` — never a crash,
/// never a guess. `grip://` is the scheme the app EMITS (widgets, the Live
/// Activity) and the server sends; `verder://` — the app's name before the
/// rename to Grip — is still ACCEPTED, with `done-by-verder` beside
/// `done-by-grip`, because links already on the phone (delivered pushes,
/// widget timelines written by the old build) carry it (`acceptedSchemes`).
/// The app registers NO URL scheme: these links
/// arrive only inside a push, or from verder's own widget (`widgetURL`, which
/// reaches `RootView.onOpenURL` without a registered scheme), so no web page
/// or other app can fire one.
enum DeepLink: Equatable, Sendable {
    case proposal(UUID)
    case suggestion(UUID)
    case task(UUID)
    case document(UUID)
    case inbox
    /// `grip://voice`: the voice quick-log (the home screen quick action,
    /// plan 3 Task 25). A sheet over whatever tab is showing, never a tab.
    case voice
    /// `grip://weekly`: the Weekoverzicht (plan 3 Task 26), on Meer. The
    /// Sunday push itself carries `grip://inbox`; `NotificationRouter`
    /// sends a tap on its `WEEKLY` category here.
    case weekly
    /// `grip://done-by-grip`: "Door verder gedaan" on Voor jou — what
    /// verder filed or renamed by itself (Overzicht's card, the daily digest).
    case doneByGrip
    /// `grip://dossier`: the Dossier tab at its root (a link-less filing
    /// push: a merged duplex scan, a new loonstrook).
    case dossier
    /// `grip://timeline`: the Tijdlijn (the case map) on Dossier.
    case timeline
    /// `grip://overzicht`: the Overzicht tab (a link-less system push).
    case overzicht
    /// `grip://money`: Geld, on Meer.
    case money
    /// `grip://scan`: the camera on Scan, at once — the home screen quick
    /// action, the Control Center control and the Action button (R20). Scan
    /// is not lock-gated, so it opens without Face ID.
    case scan
    /// `grip://call`: the call sheet in progress — the tap on the call's
    /// Live Activity (`CallActivityFaces.url`). A sheet, never a tab; with no
    /// call in progress it opens nothing more than the app.
    case call
    case none

    init(userInfo: [AnyHashable: Any]) {
        guard let link = userInfo["link"] as? String else { self = .none; return }
        self = Self.parse(link)
    }

    /// The scheme the app emits.
    static let scheme = "grip"
    /// Every scheme `parse` accepts: `scheme` plus the pre-rename `verder`.
    static let acceptedSchemes: Set<String> = [scheme, "verder"]

    static func parse(_ link: String) -> DeepLink {
        guard let parts = URLComponents(string: link),
              let scheme = parts.scheme, acceptedSchemes.contains(scheme),
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
        case "done-by-grip", "done-by-verder":
            return parts.path.isEmpty ? .doneByGrip : .none
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
        case "call":
            return parts.path.isEmpty ? .call : .none
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
        case .doneByGrip: LinkDestination(tab: .voorJou, stack: .inbox([.doneByGrip]))
        case .document(let id): LinkDestination(tab: .dossier, stack: .dossier([.document(id: id.lowerString, title: nil)]))
        case .dossier: LinkDestination(tab: .dossier, stack: .dossier([]))
        case .timeline: LinkDestination(tab: .dossier, stack: .dossier([.timeline]))
        case .overzicht: LinkDestination(tab: .home, stack: nil)
        case .weekly: LinkDestination(tab: .meer, stack: .meer([.weekly]))
        case .money: LinkDestination(tab: .meer, stack: .meer([.money]))
        case .voice: LinkDestination(tab: nil, stack: nil, opensVoice: true)
        case .scan: LinkDestination(tab: .scan, stack: nil, opensCamera: true)
        case .call: LinkDestination(tab: nil, stack: nil, opensCall: true)
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
    /// The call sheet in progress comes back (`CallSession.reopen`).
    var opensCall = false
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
