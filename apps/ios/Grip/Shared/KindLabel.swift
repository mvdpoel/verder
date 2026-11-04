import Foundation

/// The Dutch word for a waiting item's kind, keyed by the server's spelling
/// (`WaitingKind` in packages/api/src/waiting.ts). ONE definition for the Voor
/// jou list and the widget, which compiles this file without `InboxModels`.
enum KindLabel {
    static func dutch(_ kind: String) -> String {
        switch kind {
        case "proposal": "voorstel"
        case "question": "vraag"
        case "suggestion": "suggestie"
        case "task": "taak"
        case "stop": "op de kaart"
        default: "overig"
        }
    }
}
