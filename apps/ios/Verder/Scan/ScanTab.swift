import SwiftUI
import VisionKit

/// The first tab, and the reason the app exists: the camera is live on launch
/// with no tap, a finished capture is cleaned, packed and queued off the main
/// thread, and the camera is back at once for the next letter (spec §7.1,
/// anti-goal "snapping is slower than walking upstairs").
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
            camera
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
                    cameraID = UUID()
                },
                onCancel: { cameraID = UUID() })
            .id(cameraID)
            .ignoresSafeArea(edges: .bottom)
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
