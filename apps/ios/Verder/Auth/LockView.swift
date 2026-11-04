import SwiftUI
import UIKit

/// A gated tab while the app is locked: the verder mark on `void` and one way
/// through. When a tapped notification is waiting behind the lock, the target
/// screen is drawn as empty placeholder rows under its own title — never its
/// content (Figma "Lock / Koude start via melding"). No amber on the screen
/// itself: being locked is not something in the dossier waiting on Martin.
struct LockView: View {
    let lock: AppLock
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.lockedTarget) private var target

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            if let target {
                LockedPlaceholder(target: target)
            } else {
                VStack(spacing: 24) {
                    Spacer()
                    VerderRings()
                    AuthEyebrow()
                    Spacer()
                    if let message = lock.message {
                        AuthCaption(message, emphasised: true)
                    }
                    AuthButton(title: AppLock.Copy.button, enabled: !lock.isUnlocking) {
                        Task { await lock.unlock() }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
        }
        .preferredColorScheme(.dark)
        // Prompt by itself as soon as a gated screen is in the foreground, once
        // per lock (see `autoPromptIfNeeded`). Only while active: the system
        // refuses a prompt from the background.
        .task(id: scenePhase) {
            if scenePhase == .active { await lock.autoPromptIfNeeded() }
        }
    }
}

/// The waiting screen's outline: its back label and title (both a KIND, never
/// a name) over grey rows. Nothing here can load, so nothing can leak.
struct LockedPlaceholder: View {
    let target: LockedTarget

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Label(target.back, systemImage: "chevron.left")
                .font(AuthType.callout)
                .foregroundStyle(Color.inkMute)
                .frame(minHeight: 44)
            Text(target.title)
                .font(AuthType.title)
                .foregroundStyle(Color.inkBright)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 36) {
                ForEach(0..<6, id: \.self) { _ in
                    HStack(alignment: .top, spacing: 12) {
                        Circle().fill(Color.inkFaint).frame(width: 6, height: 6).padding(.top, 5)
                        VStack(alignment: .leading, spacing: 8) {
                            Capsule().fill(Color.plate).frame(width: 220, height: 10)
                            Capsule().fill(Color.plate).frame(width: 110, height: 8)
                        }
                    }
                }
            }
            .padding(.top, 40)
            .padding(.leading, 16)
            .accessibilityHidden(true)
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The target is a pushed screen (a proposal under "Voor jou"), which
        // draws no tab bar (frame "Lock / Koude start via melding").
        .toolbar(.hidden, for: .tabBar)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(target.title), vergrendeld")
    }
}

/// What follows an unlock that left the app locked (Figma "Lock / Face ID
/// geannuleerd", "… via melding geannuleerd", "Lock / Geen toegangscode"):
/// say what happened, and offer every way on — Face ID again, the counts-only
/// overview, the camera (which never needs Face ID).
struct UnlockSheetView: View {
    let sheet: AppLock.UnlockSheet
    let lock: AppLock
    let target: LockedTarget?
    let overview: () -> Void
    let scan: () -> Void

    @State private var height: CGFloat = 300
    @Environment(\.openURL) private var openURL

    enum Copy {
        static let title = "Ontgrendel je dossier"
        static let cancelled = "Je tikte op Annuleer · je dossier blijft vergrendeld."
        static let rule = "Eén keer bij openen. Ben je binnen 5 minuten terug, dan hoef je Face\u{00A0}ID niet opnieuw te gebruiken."
        static let overview = "Bekijk alleen het overzicht"
        static let scan = "Scan een brief"
        static let noPasscodeTitle = "Zet eerst een toegangscode aan"
        static let noPasscode = "Zonder toegangscode werkt Face\u{00A0}ID niet in deze app. Zet hem aan, dan werkt het meteen."
        static let settings = "Open Instellingen"
    }

    var body: some View {
        ScrollView {
            content
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .fixtureScrollAnchor()
        .presentationDetents([.height(height)])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.rail)
        .preferredColorScheme(.dark)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            AuthTitle(sheet == .cancelled ? Copy.title : Copy.noPasscodeTitle)
            if sheet == .cancelled {
                Text(Copy.cancelled)
                    .wholeWords(Copy.cancelled, font: AuthType.callout)
                    .foregroundStyle(Color.ink)
                    .padding(.top, 12)
                Text(Copy.rule)
                    .wholeWords(Copy.rule, font: AuthType.callout)
                    .foregroundStyle(Color.inkSoft)
                    .padding(.top, 16)
                if let target {
                    // Amber: this one does wait on Martin.
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle().fill(Color.attn).frame(width: 10, height: 10).glow(Glow.attn)
                        Text(target.waitingLine)
                            .wholeWords(target.waitingLine, font: AuthType.callout)
                            .foregroundStyle(Color.ink)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 20)
                    .accessibilityElement(children: .combine)
                }
            } else {
                Text(Copy.noPasscode)
                    .wholeWords(Copy.noPasscode, font: AuthType.callout)
                    .foregroundStyle(Color.ink)
                    .padding(.top, 12)
            }
            VStack(spacing: 12) {
                if sheet == .cancelled {
                    AuthButton(title: AppLock.Copy.button, enabled: !lock.isUnlocking) {
                        Task { await lock.unlock() }
                    }
                } else {
                    AuthButton(title: Copy.settings) {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                }
                AuthButton(title: Copy.overview, weight: .secondary, action: overview)
                if sheet == .cancelled {
                    AuthButton(title: Copy.scan, weight: .ghost, action: scan)
                }
            }
            .padding(.top, 20)
        }
        .fixedSize(horizontal: false, vertical: true)
        .lineHeight(.multiple(factor: AuthType.lineFactor))
        .padding(.horizontal, 16)
        .padding(.top, 32)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The app-switcher snapshot while the scene is not active (brief: "covered
/// while locked"; drawn whenever the app leaves the foreground, the safer
/// reading the frame takes — an unlocked screen in the five-minute grace is
/// still the dossier). Plain `void` with the mark: no title, no count, no
/// amount. Drawn at `.inactive`, so iOS captures it.
struct PrivacyCover: View {
    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            VStack(spacing: 24) {
                VerderRings(size: 160)
                Text("VERDER")
                    .font(.mono(17, relativeTo: .headline, weight: .medium))
                    .tracking(2)
                    .foregroundStyle(Color.inkSoft)
            }
            .offset(y: -64)
        }
        .accessibilityHidden(true)
    }
}

/// The dim over the whole app, status bar included, while Face ID is being
/// asked (frame "Lock / Face ID vraagt"): a pending prompt must not look like
/// the glance at rest. The system draws its own Face ID mark on top; this
/// only dims what is behind it. Takes the taps too, so nothing behind it can
/// be pressed while the answer is out.
struct UnlockScrim: View {
    var body: some View {
        Color.black.opacity(0.62)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .accessibilityHidden(true)
    }
}

private struct LockedTargetKey: EnvironmentKey {
    static let defaultValue: LockedTarget? = nil
}

extension EnvironmentValues {
    /// The link waiting behind the lock, for the one tab it lands on.
    var lockedTarget: LockedTarget? {
        get { self[LockedTargetKey.self] }
        set { self[LockedTargetKey.self] = newValue }
    }
}

extension View {
    /// Covers this screen with `LockView` while the app is locked. Every tab
    /// EXCEPT Scan uses it — see `AppLock` for the rule and why.
    func lockGated(by lock: AppLock) -> some View {
        modifier(LockGate(lock: lock))
    }
}

private struct LockGate: ViewModifier {
    let lock: AppLock

    func body(content: Content) -> some View {
        if lock.isGated(.dossier) {
            // Not an overlay: the gated content must not exist (and so cannot
            // load or announce anything to VoiceOver) behind the lock.
            LockView(lock: lock)
        } else {
            content
        }
    }
}
