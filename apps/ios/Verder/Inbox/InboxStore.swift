import Foundation
import Observation
import UserNotifications

/// Voor jou's data: everything waiting on Martin, as the server ranks it.
///
/// Made ONCE, in `VerderApp`, beside `PushRegistrar`: the tab reads it, and the
/// background refresh (a silent push, Task 8) calls the same `refresh`, so the
/// list, the icon badge and the widget are fed by one fetch and cannot drift.
///
/// THE BADGE AND THE WIDGET ARE THE SERVER'S COUNT, never one the phone works
/// out: `count` comes from the one definition in packages/api/src/waiting.ts.
/// A refresh that FAILS changes neither — it learned nothing, and a badge
/// zeroed by a dead network is a badge that lies.
@MainActor
@Observable
final class InboxStore {
    static let inboxPath = "/api/mobile/v1/inbox"
    static let summaryPath = "/api/mobile/v1/dashboard/summary"

    private(set) var inbox: InboxDTO?
    /// The map headline and task counts; the widget's headline comes from here.
    private(set) var summary: DashboardSummaryDTO?
    /// The inbox fetch's failure, nil after a good refresh.
    private(set) var lastError: APIError?

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let snapshotDir: URL?
    @ObservationIgnored private let setBadge: @Sendable (Int) async -> Void
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let writer: WidgetSnapshot.Writer

    init(client: APIClient,
         snapshotDir: URL? = AppGroup.containerURL,
         setBadge: @escaping @Sendable (Int) async -> Void = InboxStore.systemBadge,
         onUnauthorized: @escaping @MainActor () -> Void = {},
         now: @escaping @Sendable () -> Date = Date.init,
         writer: @escaping WidgetSnapshot.Writer = { try $0.write(to: $1, options: $2) }) {
        self.client = client
        self.snapshotDir = snapshotDir
        self.setBadge = setBadge
        self.onUnauthorized = onUnauthorized
        self.now = now
        self.writer = writer
    }

    static let systemBadge: @Sendable (Int) async -> Void = { count in
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }

    /// Fetches the inbox and the summary side by side. The inbox decides:
    /// without it nothing is written. The summary is decoration (the widget's
    /// headline), so when only it fails the count still goes through with the
    /// last known headline.
    func refresh() async {
        async let inboxResult: Result<InboxDTO, APIError> = Self.fetch(client, Self.inboxPath)
        async let summaryResult: Result<DashboardSummaryDTO, APIError> = Self.fetch(client, Self.summaryPath)
        let (i, s) = await (inboxResult, summaryResult)

        if case .success(let fresh) = s { summary = fresh }
        let dto: InboxDTO
        switch i {
        case .success(let value): dto = value
        case .failure(let error):
            lastError = error
            if error == .unauthorized { onUnauthorized() }
            return
        }
        inbox = dto
        lastError = nil

        if let snapshotDir {
            let top = dto.items.first
            let snapshot = WidgetSnapshot(count: dto.count, topTitle: top?.title, topKind: top?.kind.rawValue,
                                          headline: summary?.headline?.stopTitle, updatedAt: now())
            // A snapshot that cannot be written leaves the old one; the widget
            // ages it out after 24 h ("Open verder om bij te werken").
            try? WidgetSnapshot.write(snapshot, to: snapshotDir, writer: writer)
            WidgetSnapshot.reportProtectionIfAsked(in: snapshotDir)
        }
        await setBadge(dto.count)
    }

    nonisolated private static func fetch<T: Decodable & Sendable>(_ client: APIClient, _ path: String) async -> Result<T, APIError> {
        do {
            let value: T = try await client.getJSON(path)
            return .success(value)
        } catch let error as APIError {
            return .failure(error)
        } catch {
            return .failure(.transport(String(describing: error)))
        }
    }
}
