import Foundation
import Observation

/// `GET` / `POST /api/mobile/v1/push/preferences`: the kinds of push THIS
/// iPhone does not want, as category ids (`NotificationCategories.ids`).
/// Everything not listed is sent.
struct PushPreferencesDTO: Codable, Equatable, Sendable {
    let muted: [String]
}

/// Meer → Meldingen's switches (Figma "meer · final", Meldingen frames).
///
/// The server decides what is sent, so a switch is only true once the server
/// stored it: a failed save keeps the switch where Martin put it, says "Niet
/// opgeslagen" under it and offers a retry — it never silently snaps back,
/// and it never claims a choice the server does not hold.
///
/// A server that does not know the route (404, a web image older than the
/// phone) is `unsupported`: every kind is sent, so the screen shows each one
/// as "aan" with no switch rather than a switch that cannot save.
@MainActor
@Observable
final class NotificationPrefsModel {
    nonisolated static let path = "/api/mobile/v1/push/preferences"

    enum Availability: Equatable, Sendable {
        case loading
        /// The server stores choices: switches.
        case available
        /// The server has no such route: every kind is sent, no switches.
        case unsupported
        /// Nothing known yet and the read failed.
        case unavailable(APIError)
    }

    private(set) var availability: Availability = .loading
    /// What the server holds.
    private(set) var muted: Set<String> = []
    /// A choice the server has not (yet) stored: category → on.
    private(set) var unsaved: [String: Bool] = [:]
    /// The kind whose save failed last, for "Niet opgeslagen" under its row.
    private(set) var failed: String?
    /// Bumped on every failed save: the `.error` haptic.
    private(set) var saveFailures = 0

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.onUnauthorized = onUnauthorized
    }

    func isOn(_ category: String) -> Bool {
        if NotificationsCopy.always.contains(category) { return true }
        if let choice = unsaved[category] { return choice }
        return !muted.contains(category)
    }

    /// "8 van 9": the kinds that reach this iPhone, out of all of them. Nil
    /// while nothing is known.
    var count: (on: Int, of: Int)? {
        let all = NotificationsCopy.kinds.map(\.category)
        switch availability {
        case .available: return (all.count { isOn($0) }, all.count)
        case .unsupported: return (all.count, all.count)
        case .loading, .unavailable: return nil
        }
    }

    func refresh() async {
        do {
            let dto: PushPreferencesDTO = try await client.getJSON(Self.path)
            muted = Set(dto.muted)
            availability = .available
        } catch let error as APIError {
            if APIError.isCancellation(error) { return }
            if error == .rejected(404) { availability = .unsupported; return }
            if error == .unauthorized { onUnauthorized() }
            if availability != .available { availability = .unavailable(error) }
        } catch {
            if availability != .available { availability = .unavailable(.transport(String(describing: error))) }
        }
    }

    /// A switch moved. The whole muted list goes up, so the server's answer
    /// is never a merge of two half-states.
    func set(_ category: String, on: Bool) async {
        guard availability == .available, !NotificationsCopy.always.contains(category) else { return }
        unsaved[category] = on
        await save(category)
    }

    /// "Opnieuw proberen" under the failed row.
    func retry() async {
        guard let category = failed else { return }
        await save(category)
    }

    private func save(_ category: String) async {
        var next = muted
        for (cat, on) in unsaved {
            if on { next.remove(cat) } else { next.insert(cat) }
        }
        let body = PushPreferencesDTO(muted: next.sorted())
        do {
            let data = try APIClient.jsonEncoder.encode(body)
            var req = client.request(Self.path, method: "POST", body: data, contentType: "application/json")
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            _ = try await client.send(req)
            muted = next
            unsaved = [:]
            failed = nil
        } catch {
            if APIError.isCancellation(error) { return }
            if (error as? APIError) == .unauthorized { onUnauthorized() }
            failed = category
            saveFailures += 1
        }
    }
}
