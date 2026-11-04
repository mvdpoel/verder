import Observation

/// How many of the app's OWN system sheets are up right now — Face ID, the
/// toegangssleutel sheet, a permission alert. Each makes the scene inactive,
/// exactly as leaving for the app switcher does, and the privacy cover
/// (`PrivacyCover`) must not flash over the screen behind a sheet Martin just
/// asked for; it covers every OTHER inactive moment.
@MainActor
@Observable
final class SystemPrompts {
    static let shared = SystemPrompts()
    private(set) var open = 0

    /// Runs `body` with one sheet counted as open.
    static func around<T, E: Error>(_ body: @MainActor () async throws(E) -> T) async throws(E) -> T {
        shared.open += 1
        defer { shared.open -= 1 }
        return try await body()
    }
}
