import AppIntents

/// "Scan een brief" from outside the app (R20): the Control Center control
/// and the Action button run this, and both land on the camera at once —
/// Scan is not lock-gated, so there is no Face ID in between.
///
/// Compiled into the app AND the widget extension: a control that opens its
/// app must name an intent both know. It runs in the APP (`openAppWhenRun`),
/// where `ScanLaunch.run` hands `verder://scan` to the screens.
struct ScanLetterIntent: AppIntent {
    static let title: LocalizedStringResource = "Scan een brief"
    static let description = IntentDescription("Opent de camera van verder, zonder Face ID.")
    static let openAppWhenRun = true

    /// The words and glyph all three ways in share (frame "Scan · snelstart"):
    /// the Control Center control, the Action button's App Shortcut and the
    /// home-screen quick action (Info.plist, pinned by ScanLinkTests). Those
    /// three take only an SF Symbol name; the disc and the Scan tab draw the
    /// `ScanGlyph` asset instead, because since SF Symbols 7 this name draws
    /// a folded-corner page with no lines (identical to `doc.viewfinder`).
    static let label = "Scan een brief"
    static let symbol = "doc.text.viewfinder"

    @MainActor
    func perform() async throws -> some IntentResult {
        ScanLaunch.run?()
        return .result()
    }
}

/// The app's half of `ScanLetterIntent`: set at launch by `AppDelegate`.
@MainActor
enum ScanLaunch {
    static var run: (() -> Void)?
}
