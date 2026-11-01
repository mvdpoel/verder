import Foundation
import Observation

/// The Weekoverzicht's data: `GET /api/mobile/v1/weekly`, read when the screen
/// opens. Not kept between screens — the summary changes once a week.
///
/// A 404 is not a failure: the route answers it before the first Sunday, and
/// the screen says when the first one comes. A failed refresh keeps a summary
/// already shown; a cancelled one (the screen closed) changes nothing.
@MainActor
@Observable
final class WeeklyStore {
    static let path = "/api/mobile/v1/weekly"

    enum Copy {
        static let notYet = "Je eerste weekoverzicht komt zondag om 18:00"
        static let notYetDetail = "Daarna staat hier elke zondag wat er die week gebeurde."
    }

    enum State: Equatable {
        case loading
        case notYet
        case loaded(WeeklyScreen)
        case failed(APIError)
    }

    private(set) var state: State = .loading

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.onUnauthorized = onUnauthorized
    }

    func refresh() async {
        let result = await Self.fetch(client)
        switch result {
        case .success(let dto):
            state = .loaded(WeeklyScreen(dto))
        case .failure(.rejected(404)):
            state = .notYet
        case .failure(let error):
            if APIError.isCancellation(error) { return }
            if error == .unauthorized { onUnauthorized() }
            if case .loaded = state, error != .unauthorized { return }
            state = .failed(error)
        }
    }

    nonisolated private static func fetch(_ client: APIClient) async -> Result<WeeklyDTO, APIError> {
        do {
            let dto: WeeklyDTO = try await client.getJSON(path)
            return .success(dto)
        } catch let error as APIError {
            return .failure(error)
        } catch {
            return .failure(APIError.isCancellation(error) ? .cancelled : .transport(String(describing: error)))
        }
    }
}
