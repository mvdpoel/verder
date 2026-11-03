import SwiftUI

/// One permission pre-prompt (brief R25, Figma "auth · final", Pre-prompts
/// row): a picture of what comes, a title, what verder uses it for, at most
/// two promises, ONE button that is not titled "Toestaan", and no close. iOS's
/// own alert follows the tap. Asked at first use, never on a cold launch.
struct PermissionPrePrompt<Art: View>: View {
    let title: String
    let purpose: String
    let promises: [String]
    let proceed: () -> Void
    @ViewBuilder let art: () -> Art

    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var viewport: CGFloat = 0

    static var goOn: String { "Ga verder" }
    static var thenIOS: String { "Daarna vraagt iOS om toestemming." }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // At the accessibility sizes the words need the room the
                    // picture takes (frame "Pre-prompt / Meldingen · AX5").
                    if !typeSize.isAccessibilitySize {
                        Spacer(minLength: 24)
                        art()
                            .frame(maxWidth: .infinity)
                            .accessibilityHidden(true)
                            .padding(.bottom, 48)
                    }
                    AuthTitle(title)
                    Text(purpose)
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(Color.ink)
                        .padding(.top, 8)
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(promises, id: \.self) { promise($0) }
                    }
                    .padding(.top, 24)
                }
                .fixedSize(horizontal: false, vertical: true)
                .lineHeight(.multiple(factor: AuthType.lineFactor))
                .padding(.horizontal, 16)
                .padding(.top, typeSize.isAccessibilitySize ? 24 : 0)
                .frame(maxWidth: .infinity, minHeight: viewport, alignment: .bottomLeading)
                .padding(.bottom, 24)
            }
            .scrollBounceBehavior(.basedOnSize)
            .onGeometryChange(for: CGFloat.self) { $0.size.height * 0.92 } action: { viewport = $0 }
            VStack(spacing: 16) {
                AuthButton(title: Self.goOn, action: proceed)
                AuthCaption(Self.thenIOS)
            }
            .lineHeight(.multiple(factor: AuthType.lineFactor))
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 16)
            .overlay(alignment: .top) {
                if typeSize.isAccessibilitySize { Rectangle().fill(Color.hairline).frame(height: 1) }
            }
        }
        .background(Color.void.ignoresSafeArea())
        .authTypeCap()
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled()
    }

    private func promise(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: "checkmark")
                .font(.system(.footnote, weight: .medium))
                .foregroundStyle(Color.okay)
                .accessibilityHidden(true)
            Text(text)
                .font(AuthType.callout)
                .foregroundStyle(Color.inkSoft)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The camera pre-prompt: asked on the first tap on Scan's disc.
struct CameraPrePrompt: View {
    let proceed: () -> Void

    enum Copy {
        static let title = "Brieven scannen"
        static let purpose = "verder gebruikt de camera om brieven voor je dossier te scannen."
        static let promises = ["De camera gaat alleen aan als jij op Scan tikt.",
                               "Wat je scant, gaat alleen naar je eigen dossier."]
    }

    var body: some View {
        PermissionPrePrompt(title: Copy.title, purpose: Copy.purpose, promises: Copy.promises, proceed: proceed) {
            LetterArt()
        }
    }
}

/// The notification pre-prompt: asked after a sign-in or an unlock, never on
/// a cold launch. Its picture is a sample alert in the lock-screen shape —
/// a kind and a next step, never a creditor or an amount (brief §4).
struct NotificationPrePrompt: View {
    let proceed: () -> Void

    enum Copy {
        static let title = "Meldingen"
        static let purpose = "verder laat je weten als je bewindvoerder iets vraagt, of als er iets klaarstaat om te versturen."
        /// Both true in the code: lock-screen bodies never carry a creditor or
        /// an amount (brief §4), and Meer → Meldingen holds a switch per kind
        /// (`NotificationPrefs`, /api/mobile/v1/push/preferences).
        static let promises = ["Geen schuldeisers of bedragen op je vergrendelscherm.",
                               "Per soort uit te zetten in Meer → Meldingen."]
        static let sampleTitle = "Voorstel klaar om te keuren"
        static let sampleBody = "Antwoord aan Bewindkantoor Noordkust staat klaar."
    }

    var body: some View {
        PermissionPrePrompt(title: Copy.title, purpose: Copy.purpose, promises: Copy.promises, proceed: proceed) {
            SampleNotification(title: Copy.sampleTitle, text: Copy.sampleBody)
                .padding(.top, 180)
        }
    }
}

/// A notification as the lock screen draws it, for the pre-prompt's picture.
struct SampleNotification: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                AppIconTile(size: 20)
                Text("verder").font(AuthType.callout).foregroundStyle(Color.inkSoft)
                Spacer()
                Text("nu").font(AuthType.callout).foregroundStyle(Color.inkMute)
            }
            .padding(.bottom, 4)
            Text(title).font(AuthType.headline).foregroundStyle(Color.inkBright)
            Text(text).font(AuthType.callout).foregroundStyle(Color.ink)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.rail))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.edge, lineWidth: 1))
    }
}

/// A letter between four scan corners: the camera pre-prompt's picture, and,
/// crossed out and dimmed, the "camera uit" state's.
struct LetterArt: View {
    var crossed = false
    var width: CGFloat = 132

    var body: some View {
        let height = width * 1.3
        let bracket = crossed ? Color.inkDim : Color.signal
        ZStack {
            RoundedRectangle(cornerRadius: 2)
                .fill(Color.plate)
                .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(Color.edge, lineWidth: 1))
                .frame(width: width, height: height)
                .overlay(alignment: .topLeading) {
                    VStack(alignment: .leading, spacing: 13) {
                        line(0.46); line(0.64); line(0.58)
                        Color.clear.frame(height: 2)
                        line(0.38); line(0.64); line(0.52)
                    }
                    .padding(.top, height * 0.12)
                    .padding(.leading, width * 0.12)
                }
            Corners().stroke(bracket, style: StrokeStyle(lineWidth: crossed ? 2 : 3, lineCap: .square))
                .frame(width: width + 26, height: height + 22)
            if crossed {
                Path { p in
                    p.move(to: .zero)
                    p.addLine(to: CGPoint(x: width, y: height))
                }
                .stroke(Color.inkSoft, lineWidth: 1.2)
                .frame(width: width, height: height)
            }
        }
        .frame(width: width + 26, height: height + 22)
        .opacity(crossed ? 0.8 : 1)
    }

    private func line(_ fraction: CGFloat) -> some View {
        Capsule().fill(crossed ? Color.inkFaint : Color.steelDim).frame(width: width * fraction, height: 3)
    }

    private struct Corners: Shape {
        func path(in r: CGRect) -> Path {
            let l: CGFloat = 20
            var p = Path()
            p.move(to: CGPoint(x: r.minX, y: r.minY + l)); p.addLine(to: CGPoint(x: r.minX, y: r.minY)); p.addLine(to: CGPoint(x: r.minX + l, y: r.minY))
            p.move(to: CGPoint(x: r.maxX - l, y: r.minY)); p.addLine(to: CGPoint(x: r.maxX, y: r.minY)); p.addLine(to: CGPoint(x: r.maxX, y: r.minY + l))
            p.move(to: CGPoint(x: r.maxX, y: r.maxY - l)); p.addLine(to: CGPoint(x: r.maxX, y: r.maxY)); p.addLine(to: CGPoint(x: r.maxX - l, y: r.maxY))
            p.move(to: CGPoint(x: r.minX + l, y: r.maxY)); p.addLine(to: CGPoint(x: r.minX, y: r.maxY)); p.addLine(to: CGPoint(x: r.minX, y: r.maxY - l))
            return p
        }
    }
}

/// The disc without its button: a picture of what the camera does.
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
            ScanGlyph(size: size)
        }
        .frame(width: size, height: size)
    }
}

/// The camera is off for verder in Settings: say where to turn it on, and
/// one button that goes there (brief §2.5: cause in one line plus a verb).
/// The tab bar stays, so it is never a dead end.
struct CameraDenied: View {
    let openSettings: () -> Void

    enum Copy {
        static let title = "Scannen kan nu niet"
        static let body = "De camera staat uit in Instellingen → verder → Camera. Zet hem aan, dan kun je meteen scannen."
    }

    var body: some View {
        VStack(spacing: 0) {
            LetterArt(crossed: true)
                .accessibilityHidden(true)
            Text(Copy.title)
                .font(AuthType.headline)
                .foregroundStyle(Color.inkBright)
                .padding(.top, 64)
                .accessibilityAddTraits(.isHeader)
            Text(Copy.body)
                .font(AuthType.callout)
                .foregroundStyle(Color.inkMute)
                .padding(.top, 12)
            AuthButton(title: "Open Instellingen", action: openSettings)
                .padding(.top, 72)
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// The frames' primary button (Scan's own screens use it too).
struct ScanPrimaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        AuthButton(title: title, action: action)
    }
}
