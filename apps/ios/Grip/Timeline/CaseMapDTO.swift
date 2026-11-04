import Foundation

/// `GET /api/mobile/v1/case-map[?schuldeisers=verborgen]`, field for field
/// what `apps/web/src/lib/mobile-case-map.ts` (`toCaseMapDTO`) serves: the
/// web's /timeline map as `buildTrackMap` built it. Nothing here is derived
/// on the phone — rows, lanes, bands, edges and the current stop are the
/// server's, so the phone and the web always draw the same case.
///
/// Strings where the server has a vocabulary (`state`, `status`, `terminus`,
/// `kind`) so a new value never fails the decode; `TimelineLayout` reads them.
struct CaseMapDTO: Codable, Equatable, Sendable {
    struct Band: Codable, Equatable, Sendable {
        /// "nu", a month "2026-10", or "onbekend".
        let key: String
        let label: String
        let fromRow: Int
        /// Exclusive; equal to `fromRow` for a quiet month.
        let toRow: Int
        let empty: Bool
    }

    struct Track: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let title: String
        /// "open" | "done" | "ended". Ended is a CLEAN outcome, never a failure.
        let status: String
        let isRoot: Bool
        let parentTrackId: String?
        let note: String?
        let lane: Int
        let firstRow: Int
        let lastRow: Int
        let mergesBack: Bool
        /// "merge" | "done" | "ended" | "open" — the web's `trackTerminus`.
        let terminus: String
    }

    struct Evidence: Codable, Equatable, Sendable {
        struct Entry: Codable, Equatable, Sendable {
            let summary: String
            let occurredAt: Date
            let channel: String
            let direction: String
        }
        struct TaskLink: Codable, Equatable, Sendable {
            let id: String
            let title: String
            let status: String
            let dueAt: Date?
            let link: String
        }
        struct Document: Codable, Equatable, Sendable, Identifiable {
            let id: String
            let title: String
            let mime: String
            let link: String
        }
        struct Email: Codable, Equatable, Sendable {
            let subject: String
            let fromAddr: String
            let sentAt: Date
        }

        let entry: Entry?
        let task: TaskLink?
        let documents: [Document]
        let email: Email?

        static let none = Evidence(entry: nil, task: nil, documents: [], email: nil)

        var isEmpty: Bool { entry == nil && task == nil && documents.isEmpty && email == nil }
    }

    struct Stop: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let trackId: String
        let title: String
        let note: String?
        /// "done" | "open". An open stop is work waiting on Martin.
        let state: String
        let kind: String
        let happenedAt: Date?
        let row: Int
        let lane: Int
        let bandKey: String
        let isJunction: Bool
        let datesOutOfOrder: Bool
        let evidence: Evidence
    }

    struct Edge: Codable, Equatable, Sendable {
        /// "branch" | "merge".
        let kind: String
        let trackId: String
        let fromLane: Int
        let fromRow: Int
        let toLane: Int
        let toRow: Int
    }

    let bands: [Band]
    let tracks: [Track]
    let stops: [Stop]
    let edges: [Edge]
    let rowCount: Int
    let laneCount: Int
    let currentStopId: String?
    /// "Wat de kaart niet kon tekenen", in Dutch, as the server wrote it.
    let problems: [String]
    let hiddenDebtTrackCount: Int
    let debtEpisodesHidden: Bool
}
