import ActivityKit
import Foundation

/// The call's Live Activity (Added 2026-11-03, Martin): "maybe show tips /
/// reminders to tell or ask about live while in the call". Compiled into the
/// app (which starts, updates and ends it) and the widget extension (which
/// draws it).
///
/// PRIVACY, the rule this type exists to keep: anyone can read a lock screen.
/// So the attributes carry NOTHING about the call — no party, no number — and
/// the lock screen and the compact/minimal Dynamic Island draw COUNTS ONLY.
/// The next point's text travels in the content state for one place alone:
/// the EXPANDED Dynamic Island, which Martin opens on an unlocked phone, and
/// even there it is drawn `.privacySensitive()`. `CallActivityFaces` decides
/// every string each face shows, and `CallPrepTests` checks that no face but
/// the expanded one can contain a name or a point.
struct CallActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var discussed: Int
        var total: Int
        /// Shortened to `CallActivityFaces.nextPointMax`; nil when all are ticked.
        var nextPoint: String?
    }
}

/// Every string a face of the call's Live Activity shows. Pure.
enum CallActivityFaces {
    /// A tap on the Live Activity reopens the call sheet (`DeepLink.call`).
    static let url = URL(string: "grip://call")!

    /// The expanded island has room for about two lines.
    static let nextPointMax = 90

    static func shorten(_ text: String) -> String {
        text.count <= nextPointMax ? text : String(text.prefix(nextPointMax - 1)) + "…"
    }

    static func progress(_ s: CallActivityAttributes.ContentState) -> String {
        "\(s.discussed) van \(s.total) besproken"
    }

    static func fraction(_ s: CallActivityAttributes.ContentState) -> Double {
        s.total == 0 ? 0 : Double(s.discussed) / Double(s.total)
    }

    struct LockScreen: Equatable, Sendable {
        let title: String
        let progress: String
        let detail: String
        let fraction: Double
    }

    /// The lock screen and the banner: counts only.
    static func lockScreen(_ s: CallActivityAttributes.ContentState) -> LockScreen {
        LockScreen(title: "Gesprek · Grip", progress: progress(s),
                   detail: s.nextPoint == nil ? "Alles besproken" : "Open de app voor de punten",
                   fraction: fraction(s))
    }

    struct Compact: Equatable, Sendable {
        /// An SF Symbol name, not text.
        let leadingSymbol: String
        let leading: String
        let trailing: String
    }

    static func compact(_ s: CallActivityAttributes.ContentState) -> Compact {
        Compact(leadingSymbol: "checklist", leading: "", trailing: "\(s.discussed)/\(s.total)")
    }

    static func minimal(_ s: CallActivityAttributes.ContentState) -> String {
        "\(s.discussed)/\(s.total)"
    }

    struct Expanded: Equatable, Sendable {
        let progress: String
        let nextLabel: String
        /// The next point's text — the ONLY face that may show one.
        let nextPoint: String?
        let nextPointIsPrivacySensitive: Bool
        let fraction: Double
    }

    static func expanded(_ s: CallActivityAttributes.ContentState) -> Expanded {
        Expanded(progress: progress(s), nextLabel: s.nextPoint == nil ? "Alles besproken" : "Volgende",
                 nextPoint: s.nextPoint, nextPointIsPrivacySensitive: true, fraction: fraction(s))
    }
}
