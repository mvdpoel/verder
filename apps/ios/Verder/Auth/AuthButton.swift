import SwiftUI

/// The two button weights of the sign-in screens: `primary` is the one thing
/// to do (signal, with the action glow — glow only on what is pressable),
/// `secondary` is the alternative beside it. Never amber: nothing here is
/// waiting on Martin in the dossier.
struct AuthButton: View {
    enum Weight { case primary, secondary }

    let title: String
    var weight: Weight = .primary
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.mono(14, relativeTo: .body, weight: .medium))
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(weight == .primary ? Color.onSignal : Color.signalLink)
                .background(background)
                .overlay {
                    if weight == .secondary {
                        RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1)
                    }
                }
                .shadow(color: weight == .primary ? Glow.action.color : .clear, radius: Glow.action.radius)
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
    }

    @ViewBuilder private var background: some View {
        switch weight {
        case .primary:
            RoundedRectangle(cornerRadius: Radius.chip)
                .fill(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom))
        case .secondary:
            RoundedRectangle(cornerRadius: Radius.chip).fill(Color.field)
        }
    }
}
