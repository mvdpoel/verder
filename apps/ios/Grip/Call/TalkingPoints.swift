import Foundation

/// `GET /api/mobile/v1/parties/<id>/talking-points` — what to TELL and what
/// to ASK one party during a call, as `toTalkingPointsDTO`
/// (apps/web/src/lib/mobile-talking-points.ts) serves it. The points are read
/// off the dossier by `buildTalkingPoints`, deterministically, with no model;
/// `summary` is the ONE AI line, present only once the host drafter's answer
/// passed `validateBrief`, and always marked as AI.
///
/// WHY THIS IS A CHECKLIST AND NOT A RECORDING (Martin asked for both on
/// 2026-11-03; checked online before building): a third-party iOS app cannot
/// record or hear a phone call — there is no API for it. The iPhone's own
/// call recording is NOT available in the Netherlands (Martin, 2026-11-03:
/// support.apple.com/nl-nl/guide/iphone/iph57c6590e9/ios,
/// ben.nl/blog/telefoongesprek-opnemen-iphone,
/// simyo.nl/blog/telefoongesprek-opnemen-iphone). And
/// `CXCallObserver` (CallKit) tells an app only THAT a call started or ended,
/// never with whom or what was said. So Grip puts the dossier in front of
/// Martin during the call and lets him tick it off; after the call he records
/// what was said with the voice quick-log, as before.
struct TalkingPointsDTO: Codable, Equatable, Sendable {
    struct Party: Codable, Equatable, Sendable {
        let id: String
        let name: String
        /// What "Bel" dials. Optional: nil when Grip has no number, and
        /// absent from a server older than this field.
        var phone: String? = nil
    }

    struct Source: Codable, Equatable, Sendable {
        /// task | proposal | debt | mail | document | stop
        let type: String
        let id: String
        /// A link `DeepLink.parse` accepts (`grip://task/<id>`, `grip://dossier`, …).
        let link: String
    }

    struct Point: Codable, Equatable, Sendable, Identifiable {
        /// `<ask|tell>:<type>:<id>`, stable across refreshes.
        let id: String
        /// Dutch, at most 140 characters.
        let text: String
        let source: Source
    }

    struct SourceRef: Codable, Equatable, Sendable {
        let type: String
        let id: String
    }

    struct Summary: Codable, Equatable, Sendable {
        let text: String
        let model: String?
        let promptVersion: String?
        let generatedAt: Date
        let sourceRefs: [SourceRef]
        let ai: Bool
        let label: String
    }

    let party: Party
    let tell: [Point]
    let ask: [Point]
    let summary: Summary?
}
