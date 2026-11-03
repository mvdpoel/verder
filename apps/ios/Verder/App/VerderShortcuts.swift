import AppIntents

/// The App Shortcut the Action button (and Shortcuts, and Spotlight) offers:
/// "Actieknop → verder: Scan een brief".
struct VerderShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ScanLetterIntent(),
                    phrases: ["Scan een brief met \(.applicationName)", "\(.applicationName) scan"],
                    shortTitle: "Scan een brief",
                    systemImageName: "doc.viewfinder")
    }
}
