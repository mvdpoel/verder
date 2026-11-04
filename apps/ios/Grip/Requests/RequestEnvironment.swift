import SwiftUI

/// Vraag Grip's ways in, handed down the tree so a row anywhere (Dossier,
/// a task, a stop, Voor jou) can open the compose sheet with that item
/// attached, and a proposal can lead back to the question it came from.
struct RequestActions: Sendable {
    /// "Vraag Grip" / "Vraag Grip hierover": the compose sheet, optionally
    /// with an item attached.
    var ask: @MainActor @Sendable (RequestAbout?) -> Void = { _ in }
    /// A question's answer screen: pops back to it when it is the screen
    /// under this one ("‹ Antwoord"), else pushes it.
    var openRequest: @MainActor @Sendable (String) -> Void = { _ in }
    /// A link of the app's own (Geld, a document) from inside a sheet.
    var openLink: @MainActor @Sendable (DeepLink) -> Void = { _ in }
}

extension EnvironmentValues {
    @Entry var requestActions: RequestActions? = nil
}

/// The context-menu button itself, placed by each row's own `.contextMenu`.
struct AskGripButton: View {
    let about: RequestAbout
    @Environment(\.requestActions) private var actions

    var body: some View {
        if let actions {
            Button { actions.ask(about) } label: {
                Label(RequestText.entry, systemImage: "doc.text.magnifyingglass")
            }
        }
    }
}
