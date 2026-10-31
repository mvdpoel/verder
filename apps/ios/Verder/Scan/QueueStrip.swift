import SwiftUI

/// One line of mono micro text over the camera: "1 wordt verstuurd · 3
/// verstuurd vandaag · 1 mislukt — opnieuw". Nothing here is amber: an upload
/// on its way, or one that failed, is the system's state, not something in the
/// dossier waiting on Martin. "opnieuw" is the one action, so it is signal.
struct QueueStrip: View {
    let summary: QueueSummary
    let retry: () -> Void

    var body: some View {
        if !summary.isEmpty {
            HStack(spacing: 0) {
                Text(summary.parts.joined(separator: " · "))
                    .foregroundStyle(Color.inkDim)
                if summary.failed > 0 {
                    Text(" — ").foregroundStyle(Color.inkDim)
                    Button("opnieuw", action: retry)
                        .foregroundStyle(Color.signal)
                        .accessibilityLabel("Mislukte scans opnieuw versturen")
                }
            }
            .font(.mono(11, relativeTo: .caption2))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }
}
