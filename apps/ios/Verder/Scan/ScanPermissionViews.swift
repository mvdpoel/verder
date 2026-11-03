import SwiftUI

/// The camera pre-prompt (brief R25): asked at first use, one button that is
/// not titled "Toestaan", no close. iOS's own alert follows the tap.
struct CameraPrePrompt: View {
    let proceed: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var viewport: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // The frame's disc sits at 30 % of the screen; at the
                    // accessibility sizes the words need that room.
                    Color.clear.frame(height: typeSize.isAccessibilitySize ? 24 : viewport * 0.36)
                    ScanDiscArt(size: 128)
                        .frame(maxWidth: .infinity)
                        .accessibilityHidden(true)
                    Text("Brieven scannen")
                        .font(HomeType.title)
                        .foregroundStyle(Color.inkBright)
                        .accessibilityAddTraits(.isHeader)
                        .padding(.top, 32)
                    Text("verder gebruikt de camera om brieven voor je dossier te scannen.")
                        .font(HomeType.body)
                        .foregroundStyle(Color.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                    VStack(alignment: .leading, spacing: 12) {
                        promise("De camera gaat alleen aan als jij op scannen tikt.")
                        promise("Scannen werkt ook zonder Face ID en zonder verbinding.")
                    }
                    .padding(.top, 24)
                }
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewport = $0 }
            VStack(spacing: 16) {
                ScanPrimaryButton(title: "Ga verder", action: proceed)
                Text("Daarna vraagt iOS om toestemming.")
                    .font(.display(15, relativeTo: .footnote))
                    .foregroundStyle(Color.inkMute)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 16)
        }
        .background(Color.void.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled()
    }

    private func promise(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: "checkmark")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.okay)
                .accessibilityHidden(true)
            Text(text)
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.inkMute)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The disc without its button: the pre-prompt's picture of what comes.
struct ScanDiscArt: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(RadialGradient(colors: [Color.plate, Color.void], center: .center, startRadius: 0, endRadius: size / 2))
                .overlay(Circle().strokeBorder(Color.edgeStrong, lineWidth: 1))
            Circle()
                .strokeBorder(Color.signal, lineWidth: 1.5)
                .padding(size * 0.083)
                .glow(Glow.action)
            Image(systemName: "doc.text.viewfinder")
                .font(.system(size: size * 0.29, weight: .ultraLight))
                .foregroundStyle(Color.signal)
        }
        .frame(width: size, height: size)
    }
}

/// The camera is off for verder in Settings: say where to turn it on, and
/// one button that goes there (brief §2.5: cause in one line plus a verb).
struct CameraDenied: View {
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: "camera")
                .font(.system(size: 40, weight: .ultraLight))
                .foregroundStyle(Color.inkDim)
                .overlay {
                    // SF Symbols has no camera.slash; the frame draws one.
                    Capsule().fill(Color.inkDim).frame(width: 1.5, height: 60).rotationEffect(.degrees(-40))
                }
                .accessibilityHidden(true)
            Text("De camera staat uit voor verder")
                .font(.display(17, relativeTo: .headline, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .padding(.top, 20)
            Text("Zet hem aan in Instellingen → verder → Camera. Daarna kun je meteen scannen.")
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.inkMute)
                .padding(.top, 4)
            ScanPrimaryButton(title: "Open Instellingen", action: openSettings)
                .padding(.top, 20)
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// The frames' primary button: Saira on the signal gradient, 48 high, with
/// the action glow (glow only on what is pressable).
struct ScanPrimaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.display(17, relativeTo: .body, weight: .medium))
                .foregroundStyle(Color.onSignal)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(RoundedRectangle(cornerRadius: Radius.chip)
                    .fill(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom)))
        }
        .buttonStyle(.plain)
    }
}
