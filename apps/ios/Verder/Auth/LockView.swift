import SwiftUI

/// The verder mark on `void`, and one way through. No amber: being locked is
/// not something in the dossier waiting on Martin.
struct LockView: View {
    let lock: AppLock
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            VStack(spacing: 26) {
                Spacer()
                Text("verder")
                    .font(.display(34, relativeTo: .largeTitle, weight: .ultraLight))
                    .foregroundStyle(Color.inkBright)
                Spacer()
                if let message = lock.message {
                    Text(message)
                        .font(.display(14, relativeTo: .callout, weight: .light))
                        .foregroundStyle(Color.ink)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                AuthButton(title: AppLock.Copy.button, enabled: !lock.isUnlocking) {
                    Task { await lock.unlock() }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 26)
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
