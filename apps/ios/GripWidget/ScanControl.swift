import AppIntents
import SwiftUI
import WidgetKit

/// The Control Center (and Lock Screen) control: "Scan een brief · verder".
/// One tap opens the camera without Face ID (R20).
struct ScanControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "pro.vanderpoel.verder.scan") {
            ControlWidgetButton(action: ScanLetterIntent()) {
                Label(ScanLetterIntent.label, systemImage: ScanLetterIntent.symbol)
            }
        }
        .displayName(LocalizedStringResource(stringLiteral: ScanLetterIntent.label))
        .description("Opent de camera van verder, zonder Face ID.")
    }
}
