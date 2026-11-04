import SwiftUI
import VisionKit

/// Scan (Figma "scan · final"): the title, one line of state, the big disc
/// that opens the camera, the duplex hint, and the upload queue above the tab
/// bar while it has anything to say. Every word comes from `ScanScreen`
/// (tested); this file only lays it out.
///
/// The camera opens on a tap on the disc — or at once from the quick action,
/// the Control Center control or the Action button (`grip://scan`, R20).
/// ✓ and ✗ close it and land back here; a finished capture flies into the
/// queue (CapWords, brief §2.6) with one `.impact(.medium)`.
///
/// NOT lock-gated (plan Task 7 step 3): the camera and the queue work before
/// Face ID, because a queued scan reveals nothing. This view must never read
/// `AppLock.isLocked` or start the Face ID prompt.
struct ScanTab: View {
    let center: UploadCenter
    let auth: AuthModel
    var camera: any CameraAccess = LiveCameraAccess()
    /// Set by a `grip://scan` link; cleared here once the camera opened.
    @Binding var cameraRequested: Bool
    /// The app lock is closed. Scan only ever READS this one boolean (never
    /// `AppLock`, which could start a prompt): it says, once, that scanning
    /// needs no Face ID (FEATURES 3.22).
    var locked = false
    /// A sent row's chevron: the document on Dossier.
    var openDocument: (String) -> Void = { _ in }
    /// The flight's host above the TabView (RootView). Nil: Scan draws the
    /// flight itself (the sign-in screen's full-screen Scan, no tab bar).
    var handoff: ScanHandoff?

    @State private var cameraOpen = false
    @State private var prePrompt = false
    @State private var cameraStatus: CameraAuthorization = .authorized
    @State private var showQueue = false
    @State private var showAllSent = false
    @State private var noteTarget: NoteTarget?
    @State private var showSignIn = false
    @State private var ownHandoff = ScanHandoff()
    @State private var compactHeight = false
    @State private var unsupported = false
    @State private var failures = 0
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL

    private var ax: Bool { typeSize.isAccessibilitySize }
    private var flights: ScanHandoff { handoff ?? ownHandoff }
    /// A sheet over Scan: the page behind it dims as the frames draw it
    /// ("Scan · iets bijzonders", "Wachtrij · …"). iOS 26 leaves a sheet at a
    /// custom detent undimmed, so the dim is Scan's own.
    private var sheetOpen: Bool { showQueue || noteTarget != nil }

    private var input: ScanScreen.Input {
        ScanScreen.Input(items: center.items, signInRequired: center.signInRequired, offline: center.isOffline,
                         preparing: center.preparing, everEnqueued: center.everEnqueued, now: center.now())
    }

    var body: some View {
        // Re-read every 30 s: the duplex countdown and "vandaag" move on
        // their own.
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            page(ScanScreen(input))
        }
        .background(Color.void.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onGeometryChange(for: Bool.self) { $0.size.height < 600 } action: { compactHeight = $0 }
        .onAppear { cameraStatus = camera.status() }
        .onChange(of: cameraRequested, initial: true) { _, requested in
            guard requested else { return }
            cameraRequested = false
            openCamera()
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: center.enqueuedCount)
        .sensoryFeedback(.error, trigger: failures)
        .onChange(of: center.items.count { $0.state == .failed }) { old, new in
            if new > old { failures += 1 }
        }
        .fullScreenCover(isPresented: $cameraOpen) {
            DocumentCamera(
                onFinish: { pages in
                    cameraOpen = false
                    launchFlight(page: pages.first)
                    center.capture(pages)
                },
                onCancel: { cameraOpen = false })
            .ignoresSafeArea()
            .overlay(alignment: .top) {
                if locked { ScanLockedPill().padding(.top, 56) }
            }
        }
        .fullScreenCover(isPresented: $prePrompt) {
            CameraPrePrompt {
                Task {
                    let allowed = await SystemPrompts.around { await camera.request() }
                    cameraStatus = camera.status()
                    prePrompt = false
                    if allowed { openCamera() }
                }
            }
        }
        .sheet(isPresented: $showQueue) {
            QueueSheetView(sheet: QueueSheet(input, showAllSent: showAllSent),
                           showAllSent: $showAllSent,
                           retry: { id in Task { await center.retry(id) } },
                           note: { id in
                               showQueue = false
                               noteTarget = center.items.first { $0.id == id }.map(NoteTarget.init)
                           },
                           remove: { id in Task { await center.remove(id) } },
                           signIn: {
                               showQueue = false
                               showSignIn = true
                           },
                           open: { id in
                               showQueue = false
                               openDocument(id)
                           })
        }
        .sheet(item: $noteTarget) { target in
            ScanNoteSheet(target: target) { text in
                Task { await center.setNote(target.id, text) }
            }
        }
        .sheet(isPresented: $showSignIn) {
            SignInView(auth: auth)
        }
        // RootView resumes the queue on a new session; this only closes the sheet.
        .onChange(of: auth.sessionGeneration) { _, _ in showSignIn = false }
        #if DEBUG
        .task { await applyFixtureScan() }
        #endif
    }

    private func page(_ screen: ScanScreen) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                header(screen)
                if cameraStatus == .denied {
                    CameraDenied { openURL(URL(string: UIApplication.openSettingsURLString)!) }
                        .padding(.top, ax ? 32 : compactHeight ? 40 : 110)
                } else {
                    content(screen)
                }
            }
            .padding(.horizontal, 16)
            // The iPhone SE's status bar is 20 pt, so the header would sit
            // against it; the frame keeps the eyebrow ~40 pt from the top.
            .padding(.top, compactHeight ? 12 : 0)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity)
            // Overzicht's rhythm: Saira on 23/17 rather than its own ~1.57 em.
            .lineHeight(.multiple(factor: HomeType.sairaLineFactor))
        }
        .scrollBounceBehavior(.basedOnSize)
        // A plain inset, not `safeAreaBar`: a bar draws the system's scroll
        // edge effect as a full-width band with a hard top edge, which sliced
        // a line of text in half at AX5 (frames "AX5 · mislukt"). The frames
        // fade the page out softly just above the accessory instead.
        .scrollEdgeEffectHidden(screen.accessory != nil, for: .bottom)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let accessory = screen.accessory {
                QueueAccessoryView(accessory: accessory, ax: ax,
                                   open: { showQueue = true },
                                   act: { act(accessory.action) })
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { flights.accessoryFrame = $0 }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 8)
                    .background(alignment: .top) { AccessoryFade() }
                    .transition(.opacity)
            }
        }
        .overlay {
            Color.black.opacity(sheetOpen ? 0.7 : 0)
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                .animation(.easeInOut(duration: 0.25), value: sheetOpen)
        }
        .overlay {
            if handoff == nil { ScanHandoffOverlay(handoff: ownHandoff) }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.9),
                   value: screen.accessory)
    }

    // MARK: - Header

    private func header(_ screen: ScanScreen) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(screen.eyebrow)
                .textCase(.uppercase)
                .font(HomeType.mono)
                .lineHeight(.normal)
                .foregroundStyle(Color.inkLabel)
                .fixedSize(horizontal: false, vertical: true)
            Text("Scan")
                .font(HomeType.title)
                .foregroundStyle(Color.inkBright)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - The disc and its hints

    @ViewBuilder private func content(_ screen: ScanScreen) -> some View {
        // The slot keeps its height when empty, so the disc never jumps
        // between states. At the accessibility sizes it is left out: the
        // accessory carries the state, and the note is in the row's menu.
        if !ax {
            slot(screen.slot)
                .frame(minHeight: 44)
                .padding(.top, compactHeight ? 14 : 41)
        }
        ScanDisc(size: compactHeight ? 138 : 168, label: screen.discTitle) { tapDisc() }
            .padding(.top, ax ? 24 : 16)
        VStack(spacing: 4) {
            Text(screen.discTitle)
                .font(.display(17, relativeTo: .headline, weight: ax ? .regular : .medium))
                .foregroundStyle(Color.inkBright)
            if let sub = screen.discSubtitle, !ax {
                Text(sub)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.inkMute)
            }
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        // Uncapped (frames "AX5 · …"): at AX5 the caption runs two lines and
        // its last one scrolls under the accessory's fade, never clipped.
        .padding(.top, 16)
        .accessibilityHidden(true)
        if unsupported {
            Text("Geen camera op dit toestel.")
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.inkMute)
                .padding(.top, 8)
        }
        DuplexCard(duplex: screen.duplex)
            .padding(.top, compactHeight ? 24 : 32)
    }

    @ViewBuilder private func slot(_ slot: ScanScreen.Slot) -> some View {
        switch slot {
        case .none where locked:
            ScanLockedPill()
        case .none:
            Color.clear.frame(height: 44).accessibilityHidden(true)
        case .note(let id, let time):
            Button {
                noteTarget = center.items.first { $0.id == id }.map(NoteTarget.init)
            } label: {
                Label("Iets bijzonders bij \(time)?", systemImage: "pencil")
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.ink)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(Color.plate.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.chip))
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityHint("Voeg een notitie toe aan de scan van \(time).")
        case .line(let symbol, let text):
            Label(text, systemImage: symbol)
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.inkMute)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Actions

    private func tapDisc() {
        switch camera.status() {
        case .notDetermined:
            prePrompt = true
        case .denied:
            cameraStatus = .denied
        case .authorized:
            openCamera()
        }
    }

    private func openCamera() {
        cameraStatus = camera.status()
        guard cameraStatus == .authorized else {
            if cameraStatus == .notDetermined { prePrompt = true }
            return
        }
        guard VNDocumentCameraViewController.isSupported else {
            unsupported = true
            return
        }
        cameraOpen = true
    }

    private func act(_ action: QueueAccessory.Action?) {
        switch action {
        case .retry: Task { await center.retryFailed() }
        case .signIn: showSignIn = true
        case nil: showQueue = true
        }
    }

    // MARK: - Scan → queue (CapWords)

    private func launchFlight(page: UIImage?) {
        flights.flight = ScanHandoff.Flight(image: page.map(Self.thumbnail))
        withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.4, bounce: 0.15)) {
            flights.flight?.progress = 1
        } completion: {
            flights.flight = nil
        }
    }

    private static func thumbnail(_ page: UIImage) -> UIImage {
        let width: CGFloat = 240
        let size = CGSize(width: width, height: width * page.size.height / max(page.size.width, 1))
        return UIGraphicsImageRenderer(size: size).image { _ in page.draw(in: CGRect(origin: .zero, size: size)) }
    }

    #if DEBUG
    /// `-fixtures-scan <handoff|queue|note|preprompt>` (Grip/Fixtures): the
    /// state a frame draws that only a gesture reaches.
    private func applyFixtureScan() async {
        guard let launch = FixtureLaunch.current, let state = launch.scanState else { return }
        try? await Task.sleep(for: .seconds(0.8))
        switch state {
        case .handoff:
            var f = ScanHandoff.Flight(image: nil)
            f.progress = 0.5
            flights.flight = f
        case .queue:
            showAllSent = false
            showQueue = true
        case .note:
            if case .note(let id, _) = ScanScreen(input).slot {
                noteTarget = center.items.first { $0.id == id }.map(NoteTarget.init)
            }
        case .preprompt:
            prePrompt = true
        }
    }
    #endif
}

/// What the note sheet is about: one capture.
struct NoteTarget: Identifiable, Equatable {
    let id: UUID
    let time: String
    let pages: String?
    let note: String?

    init(_ item: UploadItem) {
        id = item.id
        time = HomeSummary.clock(item.capturedAt)
        pages = QueueSheet.pagesLabel(item)
        note = item.note
    }
}

// MARK: - Pieces

/// Behind the queue accessory: the page fades into the void over 40 pt and is
/// solid for the inset's own 12 pt above the accessory and down past the tab
/// bar, so a line scrolled under it fades out and is never sliced at the
/// accessory's edge (frames "AX5 · mislukt", "iPhone SE").
/// Not in the layout: the inset's height stays the accessory's own.
private struct AccessoryFade: View {
    static let height: CGFloat = 40

    var body: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [Color.void.opacity(0), Color.void], startPoint: .top, endPoint: .bottom)
                .frame(height: Self.height)
            Color.void
        }
        .padding(.top, -Self.height)
        .ignoresSafeArea(edges: .bottom)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The camera button: a dark disc with the signal ring, the one thing on the
/// tab you can press. Glow only here (brief: glow is a signal).
struct ScanDisc: View {
    let size: CGFloat
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(RadialGradient(colors: [Color.plate, Color.void], center: .center,
                                         startRadius: 0, endRadius: size / 2))
                    .overlay(Circle().strokeBorder(Color.edgeStrong, lineWidth: 1))
                    .shadow(color: .black.opacity(0.6), radius: 12, y: 6)
                Circle()
                    .strokeBorder(Color.signal, lineWidth: 1.5)
                    .padding(size * 0.083)
                    .glow(Glow.action)
                ScanGlyph(size: size)
            }
            .frame(width: size, height: size)
            .contentShape(Circle())
        }
        .buttonStyle(DiscPress())
        .accessibilityLabel(label)
        .accessibilityHint("Opent de camera.")
    }

    private struct DiscPress: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .animation(.spring(response: 0.2, dampingFraction: 0.7), value: configuration.isPressed)
        }
    }
}

/// The disc's glyph: a page with lines in a viewfinder, as the frames draw it.
/// A vector asset, not `doc.text.viewfinder`: since SF Symbols 7 that name
/// draws the same folded-corner page with no lines as `doc.viewfinder`.
/// "Vergrendeld · scannen kan zonder Face ID" — the camera is no way into the
/// dossier, and Scan says so in one calm line while the app is locked.
struct ScanLockedPill: View {
    var body: some View {
        Label {
            Text("Vergrendeld · scannen kan zonder Face\u{00A0}ID")
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "lock.fill").font(.system(size: 11, weight: .medium))
        }
        .font(.mono(12, relativeTo: .caption))
        .foregroundStyle(Color.inkSoft)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(minHeight: 32)
        .background(Capsule().fill(Color.rail.opacity(0.92)))
        .overlay(Capsule().strokeBorder(Color.edge, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

struct ScanGlyph: View {
    /// The disc's diameter; the glyph's viewfinder spans 30 % of it.
    let size: CGFloat
    static let asset = "ScanGlyph"
    /// The Scan tab's item: the same drawing at tab size, heavier stroke.
    static let tabAsset = "ScanGlyphTab"

    var body: some View {
        Image(Self.asset)
            .resizable()
            .scaledToFit()
            .frame(width: size * 0.3, height: size * 0.3)
            .foregroundStyle(Color.signal)
            .accessibilityHidden(true)
    }
}

/// "Dubbelzijdig": the one instruction (brief, Scan row).
struct DuplexCard: View {
    let duplex: ScanScreen.Duplex

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(duplex.label)
                .textCase(.uppercase)
                .font(.mono(12, relativeTo: .caption))
                .lineHeight(.normal)
                .tracking(0.6)
                .foregroundStyle(Color.inkLabel)
            Text(duplex.text)
                .font(.display(15, relativeTo: .callout))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }
}

/// A page as the queue draws it: the capture's own image, or paper with lines.
struct PageThumb: View {
    let image: UIImage?

    var body: some View {
        if let image {
            Image(uiImage: image).resizable().scaledToFill()
                .clipShape(RoundedRectangle(cornerRadius: 3))
                .shadow(color: .black.opacity(0.5), radius: 10, y: 6)
        } else {
            RoundedRectangle(cornerRadius: 3)
                .fill(Color.inkSoft)
                .overlay(alignment: .topLeading) {
                    GeometryReader { geo in
                        VStack(alignment: .leading, spacing: geo.size.height * 0.08) {
                            ForEach([0.55, 0.75, 0.6, 0.85, 0.7, 0.5], id: \.self) { w in
                                Capsule().fill(Color.inkDim)
                                    .frame(width: geo.size.width * 0.8 * w, height: max(1, geo.size.height * 0.025))
                            }
                        }
                        .padding(geo.size.width * 0.12)
                    }
                }
                .shadow(color: .black.opacity(0.5), radius: 10, y: 6)
        }
    }
}
