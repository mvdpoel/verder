import SwiftUI

/// The system's two faces, bundled (both SIL OFL 1.1; the licence sits beside
/// each file in `Resources/Fonts/`). They are registered by `UIAppFonts` in the
/// Info.plist (see project.yml), so nothing is loaded at runtime and the app
/// never fetches a typeface from anyone.
///
/// - Saira (display): ONE variable file, `Saira[wdth,wght]` from google/fonts,
///   weight axis 100…900 — the web loads 200/300/400/500 of the same family.
/// - IBM Plex Mono (mono): Regular, Medium, SemiBold static files.
///
/// Both scale with Dynamic Type through `relativeTo:`.
enum FontFamily {
    static let display = "Saira"
    static let mono = "IBM Plex Mono"
    /// The files listed under `UIAppFonts`, so a test can prove they shipped.
    static let files = [
        "Saira-Variable.ttf",
        "IBMPlexMono-Regular.ttf",
        "IBMPlexMono-Medium.ttf",
        "IBMPlexMono-SemiBold.ttf",
    ]
}

extension Font {
    /// Saira. The web's headings run light (200–300); body text is 400.
    static func display(_ size: CGFloat, relativeTo style: Font.TextStyle = .body, weight: Font.Weight = .regular) -> Font {
        .custom(FontFamily.display, size: size, relativeTo: style).weight(weight)
    }

    /// IBM Plex Mono: dates, channels, statuses, buttons — everything measured.
    static func mono(_ size: CGFloat, relativeTo style: Font.TextStyle = .caption, weight: Font.Weight = .regular) -> Font {
        .custom(FontFamily.mono, size: size, relativeTo: style).weight(weight)
    }
}
