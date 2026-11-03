import Foundation
import Observation
import UserNotifications
import WidgetKit

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
    /// When the inbox on hand was fetched: the age of a board kept through a
    /// failure ("bijgewerkt gisteren 22:14"). Nil until the first good refresh.
    private(set) var fetchedAt: Date?
    /// When the last refresh finished, good or bad: "volgende poging" counts on it.
    private(set) var attemptedAt: Date?

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let snapshotDir: URL?
    @ObservationIgnored private let setBadge: @Sendable (Int) async -> Void
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let writer: WidgetSnapshot.Writer
    @ObservationIgnored private let reloadWidgets: @MainActor () -> Void
    @ObservationIgnored private let epoch: SessionEpoch

    init(client: APIClient,
         snapshotDir: URL? = AppGroup.containerURL,
         setBadge: @escaping @Sendable (Int) async -> Void = InboxStore.systemBadge,
         onUnauthorized: @escaping @MainActor () -> Void = {},
         now: @escaping @Sendable () -> Date = Date.init,
         writer: @escaping WidgetSnapshot.Writer = { try $0.write(to: $1, options: $2) },
         reloadWidgets: @escaping @MainActor () -> Void = { WidgetCenter.shared.reloadAllTimelines() },
         epoch: SessionEpoch = SessionEpoch()) {
        self.client = client
        self.epoch = epoch
        self.snapshotDir = snapshotDir
        self.setBadge = setBadge
        self.onUnauthorized = onUnauthorized
        self.now = now
        self.writer = writer
        self.reloadWidgets = reloadWidgets
        epoch.whenEnded { [weak self] in self?.sessionEnded() }
    }

    static let systemBadge: @Sendable (Int) async -> Void = { count in
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }

    /// Fetches the inbox and the summary side by side. The inbox decides:
    /// without it nothing is written. The summary is decoration (the widget's
    /// headline), so when only it fails the count still goes through with the
    /// last known headline.
    ///
    /// A refresh that outlives its session (Martin signed out, or a 401
    /// elsewhere, while it waited) writes NOTHING: no list, no snapshot, no
    /// badge — and its own 401 is about a session already gone, so it does
    /// not end the next one either.
    func refresh() async {
        let started = epoch.current
        async let inboxResult: Result<InboxDTO, APIError> = Self.fetch(client, Self.inboxPath)
        async let summaryResult: Result<DashboardSummaryDTO, APIError> = Self.fetch(client, Self.summaryPath)
        let (i, s) = await (inboxResult, summaryResult)
        guard epoch.isCurrent(started) else { return }

        if case .success(let fresh) = s { summary = fresh }
        attemptedAt = now()
        let dto: InboxDTO
        switch i {
        case .success(let value): dto = value
        case .failure(let error):
            lastError = error
            if error == .unauthorized {
                forgetCaseContent()
                onUnauthorized()
            }
            return
        }
        inbox = dto
        lastError = nil
        fetchedAt = attemptedAt

        if let snapshotDir {
            let top = dto.items.first
            let snapshot = WidgetSnapshot(
                count: dto.count, topTitle: top?.title, topKind: top?.kind.rawValue,
                headline: summary?.headline?.stopTitle, updatedAt: now(),
                items: dto.items.prefix(WidgetSnapshot.maxItems).map {
                    WidgetSnapshot.Item(kind: $0.kind.rawValue, id: $0.id, title: $0.title)
                },
                oldestAt: dto.items.map(\.at).min())
            // A snapshot that cannot be written leaves the old one; the widget
            // ages it out after 24 h ("Open verder om bij te werken").
            if (try? WidgetSnapshot.write(snapshot, to: snapshotDir, writer: writer)) != nil {
                // The widget reads only this file; tell WidgetKit it changed.
                reloadWidgets()
            }
            WidgetSnapshot.reportProtectionIfAsked(in: snapshotDir)
        }
        await setBadge(dto.count)
        // The session ended while the badge was being set: the ender's 0 may
        // have landed first, so say 0 again, last.
        if !epoch.isCurrent(started) { await setBadge(0) }
    }

    /// The session ended (`SessionEpoch`): nothing of the case stays in
    /// memory, in the widget, or on the icon.
    private func sessionEnded() {
        lastError = nil
        fetchedAt = nil
        attemptedAt = nil
        forgetCaseContent()
        let setBadge = setBadge
        Task { await setBadge(0) }
    }

    /// A rejected session leaves nothing of the case behind: not in memory for
    /// the next screen, and not in the widget's snapshot, which the home
    /// screen would otherwise keep drawing for up to a day.
    private func forgetCaseContent() {
        inbox = nil
        summary = nil
        if let snapshotDir {
            WidgetSnapshot.erase(in: snapshotDir)
            reloadWidgets()
        }
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
