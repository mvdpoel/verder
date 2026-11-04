import Foundation

/// The file name a capture is uploaded under: `Scan 2026-10-28 14.05.pdf`.
///
/// Always the Amsterdam wall clock, never UTC and never the phone's own zone:
/// the dossier is Dutch, Martin reads times in Europe/Amsterdam, and a phone
/// abroad must not name a letter by a clock nobody in the case uses.
enum ScanNaming {
    static func title(capturedAt: Date) -> String {
        "Scan \(formatter.string(from: capturedAt)).pdf"
    }

    /// `DateFormatter` is thread-safe for formatting since iOS 7, but it is not
    /// `Sendable`, so a shared instance is built per call site's need instead
    /// of shared across isolation domains.
    private static var formatter: DateFormatter {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Europe/Amsterdam")
        f.dateFormat = "yyyy-MM-dd HH.mm"
        return f
    }
}
