import Foundation
import Observation

/// Where a tapped notification leads, parsed from the push payload's `link`
/// (`verder://proposal/<uuid>`, `verder://suggestion/<uuid>`,
/// `verder://task/<uuid>`, `verder://document/<uuid>`, `verder://inbox`).
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

    /// The tab a link opens. A proposal, suggestion or task opens Voor jou with
    /// that item on top (RootView pushes it); both tabs are lock-gated, so whatever the link
    /// points at is shown only after unlock.
    var tab: RootView.TabID? {
        switch self {
        case .proposal, .suggestion, .task, .inbox: .voorJou
        case .document: .dossier
        case .voice, .none: nil
        }
    }
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
