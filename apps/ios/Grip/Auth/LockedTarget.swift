import Foundation

/// What a tapped notification (or widget) points at while the app is locked,
/// reduced to its KIND (FEATURES 3.19). The lock names the kind — "Een voorstel
/// wacht na ontgrendelen", in amber because it waits on Martin — and draws the
/// target screen as empty placeholder rows, NEVER its content: a title, a
/// party or an amount is not built until Face ID.
struct LockedTarget: Equatable, Sendable {
    let tab: RootView.TabID
    /// The back button's label on the placeholder ("Voor jou").
    let back: String
    /// The placeholder screen's title ("Voorstel").
    let title: String
    /// The sentence's subject ("Een voorstel").
    let noun: String

    var waitingLine: String { "\(noun) wacht na ontgrendelen" }

    /// Only links to ONE item have a kind worth naming; a link to a tab
    /// (Voor jou, Dossier, …) waits silently.
    init?(_ link: DeepLink) {
        switch link {
        case .proposal: self.init(tab: .voorJou, back: "Voor jou", title: "Voorstel", noun: "Een voorstel")
        case .request: self.init(tab: .voorJou, back: "Voor jou", title: "Antwoord", noun: "Een antwoord van Grip")
        case .suggestion: self.init(tab: .voorJou, back: "Voor jou", title: "Suggestie", noun: "Een suggestie")
        case .task: self.init(tab: .voorJou, back: "Voor jou", title: "Taak", noun: "Een taak")
        case .document: self.init(tab: .dossier, back: "Dossier", title: "Document", noun: "Een document")
        default: return nil
        }
    }

    init(tab: RootView.TabID, back: String, title: String, noun: String) {
        self.tab = tab
        self.back = back
        self.title = title
        self.noun = noun
    }
}
