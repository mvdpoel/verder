import AppIntents

/// The App Shortcut the Action button (and Shortcuts, and Spotlight) offers:
/// "Actieknop → verder: Scan een brief".
struct VerderShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ScanLetterIntent(),
                    phrases: ["Scan een brief met \(.applicationName)", "\(.applicationName) scan"],
                    // Literals: App Shortcuts are read at build time and refuse
                    // a constant. Keep them equal to ScanLetterIntent.label/.symbol.
                    shortTitle: "Scan een brief",
                    systemImageName: "doc.text.viewfinder")
    }
}
