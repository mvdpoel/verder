import Foundation
import Observation

/// `GET /api/mobile/v1/me` (apps/web/src/lib/mobile-account.ts): who the phone
/// is signed in as and how many passkeys the account holds. Decoded strictly:
/// an answer without an email is no answer.
struct AccountDTO: Codable, Equatable, Sendable {
    let email: String
    let name: String?
    let passkeys: Int
}

/// Meer → Account's data. Read when Meer opens and after a passkey is added;
/// a failed refresh keeps what is shown, a 401 ends the session.
@MainActor
@Observable
final class AccountModel {
    nonisolated static let path = "/api/mobile/v1/me"

    enum State: Equatable {
        case loading
        case loaded(AccountDTO)
        case failed(APIError)
    }

    private(set) var state: State = .loading
    /// The last good answer, kept through a failed refresh.
    private(set) var account: AccountDTO?

    var email: String? { account?.email }
    var passkeys: Int? { account?.passkeys }

    /// What Meer → Account draws. A cached account wins over a failed
    /// refresh; with nothing cached a failure is `unavailable` with its cause,
    /// never a "wordt opgehaald…" that waits forever.
    enum Display: Equatable {
        case loading
        case shown(AccountDTO)
        case unavailable(String)
    }

    var display: Display {
        if let account { return .shown(account) }
        if case .failed(let error) = state { return .unavailable(VoorJouTab.message(error)) }
        return .loading
    }

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.onUnauthorized = onUnauthorized
    }

    func refresh() async {
        // A retry with nothing shown reads as loading again, not as the old error.
        if account == nil { state = .loading }
        switch await Self.fetch(client) {
        case .success(let dto):
            account = dto
            state = .loaded(dto)
        case .failure(let error):
            if APIError.isCancellation(error) { return }
            if error == .unauthorized {
                account = nil
                onUnauthorized()
            }
            state = .failed(error)
        }
    }

    /// Signing out forgets who was signed in.
    func forget() {
        account = nil
        state = .loading
    }

    nonisolated private static func fetch(_ client: APIClient) async -> Result<AccountDTO, APIError> {
        do {
            let dto: AccountDTO = try await client.getJSON(path)
            return .success(dto)
        } catch let error as APIError {
            return .failure(error)
        } catch {
            return .failure(APIError.isCancellation(error) ? .cancelled : .transport(String(describing: error)))
        }
    }
}
