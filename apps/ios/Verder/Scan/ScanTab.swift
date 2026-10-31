import SwiftUI
import VisionKit

/// The first tab, and the reason the app exists: the camera is live on launch
/// with no tap, and a finished capture is cleaned, packed and queued off the
/// main thread (spec §7.1, anti-goal "snapping is slower than walking upstairs").
///
/// ✓ and ✗ CLOSE the camera and land on a calm idle screen with one button to
/// scan the next letter. The first version re-armed a fresh camera in place on
/// both buttons, so on the phone neither ever visibly closed the camera and the
/// tab bar was unreachable (measured with Martin, 2026-10-31).
///
/// NOT lock-gated (plan Task 7 step 3): the camera and the queue work before
/// Face ID, because a queued scan reveals nothing. This view must never read
/// `AppLock.isLocked` or start the Face ID prompt.
struct ScanTab: View {
    let center: UploadCenter
    let auth: AuthModel

    /// A fresh camera per capture: VisionKit's controller keeps its finished
    /// pages, so "back at once" means a new one.
    @State private var cameraID = UUID()
    /// Open on launch (no tap); closed by ✓ or ✗.
    @State private var cameraOpen = true
    /// Pages in the last capture, for the idle screen's confirmation.
    @State private var lastPages: Int?
    @State private var showSignIn = false

    var body: some View {
        VStack(spacing: 0) {
            if center.signInRequired {
                signInBanner
            }
            if let message = center.message {
                Text(message)
                    .font(.display(14, relativeTo: .callout, weight: .light))
                    .foregroundStyle(Color.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
            }
            QueueStrip(summary: summaryWithPreparing) {
                Task { await center.retryFailed() }
            }
            if cameraOpen {
                camera
            } else {
                idle
            }
        }
        .background(Color.void.ignoresSafeArea())
        .sheet(isPresented: $showSignIn) {
            SignInView(auth: auth)
        }
        // RootView resumes the queue on a new session; this only closes the sheet.
        .onChange(of: auth.sessionGeneration) { _, _ in
            showSignIn = false
        }
    }

    /// Captures still being packed count as "wordt verstuurd" too: to Martin
    /// they are already on their way.
    private var summaryWithPreparing: QueueSummary {
        var s = center.summary
        s.underway += center.preparing
        return s
    }

    @ViewBuilder private var camera: some View {
        if VNDocumentCameraViewController.isSupported {
            DocumentCamera(
                onFinish: { pages in
                    center.capture(pages)
                    lastPages = pages.count
                    cameraOpen = false
                },
                onCancel: {
                    lastPages = nil
                    cameraOpen = false
                })
            .id(cameraID)
        } else {
            // The simulator has no document camera.
            VStack {
                Spacer()
                Text("Geen camera beschikbaar op dit toestel.")
                    .font(.display(14, relativeTo: .callout, weight: .light))
                    .foregroundStyle(Color.inkMute)
                Spacer()
            }
            .frame(maxWidth: .infinity)
        }
    }

    /// Between scans: what just went, and one button for the next letter.
    private var idle: some View {
        VStack(spacing: 21) {
            Spacer()
            if let n = lastPages {
                Text(n == 1 ? "1 pagina in de wachtrij" : "\(n) pagina's in de wachtrij")
                    .font(.display(20, relativeTo: .title3, weight: .light))
                    .foregroundStyle(Color.inkBright)
            }
            AuthButton(title: lastPages == nil ? "Scan een brief" : "Volgende brief scannen") {
                cameraID = UUID()
                cameraOpen = true
            }
            .padding(.horizontal, 34)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    /// Amber-free: the session ran out, which is the system's state, not an
    /// item in the dossier waiting on Martin. The scans themselves stay
    /// pending and go as soon as he is signed in again.
    private var signInBanner: some View {
        Button { showSignIn = true } label: {
            HStack(spacing: 13) {
                Text(UploadCenter.Copy.signInRequired)
                    .font(.display(14, relativeTo: .callout, weight: .light))
                    .foregroundStyle(Color.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Text("Inloggen")
                    .font(.mono(12, relativeTo: .caption, weight: .medium))
                    .foregroundStyle(Color.signalLink)
            }
            .padding(13)
            .glassPanel()
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}
