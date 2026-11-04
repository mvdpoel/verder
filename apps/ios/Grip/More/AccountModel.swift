import Foundation
import Observation

/// `GET /api/mobile/v1/me` (apps/web/src/lib/mobile-account.ts): who the phone
/// is signed in as and how many toegangssleutels (passkeys) the account holds.
/// Decoded strictly: an answer without an email is no answer.
///
/// `sessionExpiresAt` and `devices` came later (2026-11-03, the "meer · final"
/// frames' "sessie tot 1 dec" and "3 ingelogd"); a server that predates them
/// leaves them nil, and the phone then says nothing about either rather than
/// guessing.
struct AccountDTO: Codable, Equatable, Sendable {
    let email: String
    let name: String?
    let passkeys: Int
    /// When THIS session ends (better-auth's `session.expiresAt`).
    var sessionExpiresAt: Date? = nil
    /// Live sessions on the account: every iPhone and browser signed in.
    var devices: Int? = nil
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
    /// When `account` was fetched: the "bijgewerkt 14:02" of an offline Meer.
    private(set) var fetchedAt: Date?
    /// When the last attempt failed: "verder was niet bereikbaar · 14:02".
    private(set) var failedAt: Date?

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

    /// The last attempt reached no server at all (no HTTP answer).
    var lastFailureWasTransport: Bool {
        if case .failed(.transport) = state { return true }
        return false
    }

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored let now: @Sendable () -> Date

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {},
         now: @escaping @Sendable () -> Date = Date.init) {
        self.client = client
        self.onUnauthorized = onUnauthorized
        self.now = now
    }

    func refresh() async {
        // A retry with nothing shown reads as loading again, not as the old error.
        if account == nil { state = .loading }
        let at = now()
        switch await Self.fetch(client) {
        case .success(let dto):
            account = dto
            fetchedAt = at
            failedAt = nil
            state = .loaded(dto)
        case .failure(let error):
            if APIError.isCancellation(error) { return }
            failedAt = at
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
        fetchedAt = nil
        failedAt = nil
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
