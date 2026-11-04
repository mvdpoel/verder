import PDFKit
import SwiftUI
import UIKit

/// How the viewer renders a document, from the file route's `Content-Type`
/// (the sniffed, safe type — the stored `mime` can say octet-stream).
enum ViewerKind: Equatable, Sendable {
    case pdf, image, unsupported

    init(contentType: String?) {
        let type = contentType?.split(separator: ";").first?
            .trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        if type == "application/pdf" { self = .pdf }
        else if type.hasPrefix("image/") { self = .image }
        else { self = .unsupported }
    }
}

/// The viewer's bytes: the phone's own copy; for a document the server
/// listed but the phone could not take in, a prompt to take it in ("Haal nu
/// op", kept afterwards); for one the phone knows nothing about (a server
/// search hit, a link before the first sync), fetched for this one viewing
/// and never stored.
@MainActor
@Observable
final class DocumentViewerModel {
    enum Content: Equatable {
        case loading
        case pdf(Data)
        case image(Data)
        case unsupported
        case failed(String)
        /// Listed, not on the phone: "Nog niet op deze iPhone · 0,4 MB".
        case notHere(DossierDoc)
    }

    enum Copy {
        static let unsupported = "Dit soort bestand kan de telefoon niet tonen. Open het in verder op de computer."
        static let gone = "Dit document is er niet meer."
        static let offline = "Dit document staat nog niet op je telefoon, en er is geen verbinding."
        static let failed = "Het document kon niet worden geopend."
        static let notHere = "Nog niet op deze iPhone"
        static let takeIn = "Haal nu op"
        static let takeInOffline = "Haal het op zodra je weer online bent. Daarna kun je het ook zonder verbinding openen."
        static let takeInFailed = "Het document kwam niet goed binnen. Probeer het nog eens."
        static let counter = "Toon aan de balie"
        static let noTextLabel = "geen tekst herkend"
        static let noText = "Zoeken vindt deze scan alleen op de titel. Tonen aan de balie werkt gewoon."
    }

    private(set) var content: Content = .loading
    /// The bytes came from the phone's own copy (so its record says what it is).
    private(set) var fromPhone = false
    /// "Haal nu op" is underway.
    private(set) var takingIn = false
    private(set) var takeInFailed = false

    @ObservationIgnored let id: String
    @ObservationIgnored private let store: DossierStore
    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let dossier: DossierModel?
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void

    init(id: String, store: DossierStore, client: APIClient, dossier: DossierModel? = nil,
         onUnauthorized: @escaping @MainActor () -> Void) {
        self.id = id
        self.store = store
        self.client = client
        self.dossier = dossier
        self.onUnauthorized = onUnauthorized
    }

    /// What the phone knows about this document: its record, held or not.
    var record: DossierDoc? { dossier?.doc(id) ?? dossier?.notHeldDoc(id) }

    /// The pages of what is shown: the record's count, else the bytes' own.
    var pages: Int? {
        if let n = dossier?.docs.first(where: { $0.id == id })?.pages { return n }
        if case .pdf(let data) = content { return PDFDocument(data: data)?.pageCount }
        return nil
    }

    var isOffline: Bool { dossier?.offline ?? false }

    /// The data is decided again on every look the dossier takes, unless a
    /// document is on screen: a link opened before the first sync learns
    /// afterwards that its document is listed but not held.
    var settled: Bool {
        switch content {
        case .pdf, .image, .unsupported: true
        case .loading, .failed, .notHere: false
        }
    }

    func load() async {
        // Before the phone's copy is read nothing is known about this
        // document; the dossier's next look (`revision`) asks again.
        if let dossier, !dossier.loaded { return }
        if let url = await store.fileURL(id), let data = try? Data(contentsOf: url) {
            fromPhone = true
            content = Self.content(data, contentType: await store.contentType(id))
            return
        }
        if let listed = dossier?.notHeldDoc(id) { content = .notHere(listed); return }
        guard UUID(uuidString: id) != nil else { content = .failed(Copy.gone); return }
        do {
            let req = client.request("/api/mobile/v1/documents/\(id)/file", method: "GET", body: nil, contentType: nil)
            let (data, http) = try await client.send(req)
            fromPhone = false
            content = Self.content(data, contentType: http.value(forHTTPHeaderField: "Content-Type"))
        } catch let error as APIError {
            switch error {
            case .unauthorized: onUnauthorized(); content = .failed("Log opnieuw in.")
            case .rejected(404), .rejected(410): content = .failed(Copy.gone)
            case .transport: content = .failed(Copy.offline)
            default: content = .failed(Copy.failed)
            }
        } catch {
            content = .failed(Copy.failed)
        }
    }

    /// "Haal nu op": the document is taken in and KEPT, then shown.
    func takeIn() async {
        guard case .notHere(let doc) = content, let dossier, !takingIn else { return }
        takingIn = true
        takeInFailed = false
        defer { takingIn = false }
        if await dossier.takeIn(doc) { await load() } else { takeInFailed = !dossier.offline }
    }

    static func content(_ data: Data, contentType: String?) -> Content {
        switch ViewerKind(contentType: contentType) {
        case .pdf: .pdf(data)
        case .image: .image(data)
        case .unsupported: .unsupported
        }
    }
}

/// A document, as the "Document / viewer" frame draws it: its readout line
/// and title, ONE page at a time (pinch to zoom, swipe or the pager to turn),
/// "PAGINA 1 VAN 2", and "Toon aan de balie" pinned at the bottom. Pushed on
/// the Dossier stack with the tab bar hidden, so the edge swipe goes back.
/// Read-only: nothing here changes a document, and purge is never offered;
/// "Deel…" hands the file to another app on Martin's own tap.
struct DocumentViewer: View {
    let title: String
    @State private var model: DocumentViewerModel
    @State private var pager = PDFPager()
    @State private var counter = false
    private let dossier: DossierModel?
    /// Opened from the list's "Toon aan de balie": the counter comes up as
    /// soon as the document is on screen.
    private let opensCounter: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    private var ax: Bool { typeSize.isAccessibilitySize }

    init(id: String, title: String, store: DossierStore, client: APIClient, dossier: DossierModel? = nil,
         opensCounter: Bool = false, onUnauthorized: @escaping @MainActor () -> Void) {
        self.title = title
        self.dossier = dossier
        self.opensCounter = opensCounter
        _model = State(initialValue: DocumentViewerModel(id: id, store: store, client: client, dossier: dossier,
                                                         onUnauthorized: onUnauthorized))
    }

    private var now: Date { dossier?.now() ?? Date() }
    private var shownTitle: String { model.record?.title ?? title }

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            if ax {
                ScrollView { column.padding(.horizontal, 16).padding(.bottom, 16) }
                    .fixtureViewerScroll()
            } else {
                column.padding(.horizontal, 16)
            }
        }
        .safeAreaInset(edge: .bottom) { bottomAction }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { shareButton }
        }
        .preferredColorScheme(.dark)
        .task(id: dossier?.revision ?? 0) { if !model.settled { await model.load() } }
        .fullScreenCover(isPresented: $counter) {
            CounterView(content: model.content, title: shownTitle)
        }
        .task(id: model.settled) { if opensCounter, model.settled { counter = true } }
        .onDisappear { SharedDocument.cleanUp() }
        #if DEBUG
        .task(id: model.settled) {
            guard model.settled, let state = FixtureLaunch.current?.dossier else { return }
            if state.contains(.balie) || state.contains(.balieZoom) { counter = true }
        }
        #endif
    }

    // MARK: - The column

    @ViewBuilder private var column: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !ax, let line = metaLine {
                Text(line).font(.mono(12, relativeTo: .caption)).monoCap().tracking(1)
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }
            Text(shownTitle)
                .font(.display(28, relativeTo: .title2))
                // 49 pt at AX5 (the frames' AX5 ramp), so the page keeps its room.
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, ax ? 8 : 2)
                .padding(.bottom, 16)
                .id(ViewerAnchor.title)
            page
                .frame(maxWidth: .infinity)
                .frame(height: ax ? 342 : nil)
                .frame(maxHeight: ax ? nil : .infinity)
                .id(ViewerAnchor.page)
            below
            if ax, let parts = metaParts {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(parts, id: \.self) { Text($0) }
                }
                .font(.mono(12, relativeTo: .caption)).monoCap()
                .foregroundStyle(Color.inkLabel)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
                .padding(.top, 8)
            }
        }
    }

    private var metaParts: [String]? {
        model.record.map { DossierLine.viewer($0, pages: model.pages, held: dossier?.doc(model.id) != nil, now: now) }
    }

    private var metaLine: String? { metaParts.map(DossierLine.joined) }

    @ViewBuilder private var page: some View {
        switch model.content {
        case .loading:
            Color.plate.opacity(0.6)
        case .pdf(let data):
            PDFKitView(data: data, pager: pager, label: shownTitle)
        case .image(let data):
            if let image = UIImage(data: data) {
                ZoomableImageView(image: image, label: shownTitle)
            } else {
                notice(DocumentViewerModel.Copy.failed)
            }
        case .unsupported:
            notice(DocumentViewerModel.Copy.unsupported)
        case .failed(let message):
            notice(message)
        case .notHere(let doc):
            notHereBox(doc)
        }
    }

    /// Under the page: the pager for a PDF of more than one page; for a scan
    /// with no text, what that means.
    @ViewBuilder private var below: some View {
        if case .pdf = model.content, pager.count > 1 {
            pagerRow.padding(.vertical, ax ? 8 : 12)
        } else if dossier?.doc(model.id)?.hasText == false {
            DossierNotice(label: DocumentViewerModel.Copy.noTextLabel, text: DocumentViewerModel.Copy.noText)
                .padding(.vertical, 16)
        } else if case .notHere = model.content, model.isOffline || model.takeInFailed {
            Label {
                Text(model.takeInFailed ? DocumentViewerModel.Copy.takeInFailed : DocumentViewerModel.Copy.takeInOffline)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "wifi.slash").font(.system(size: 13)).foregroundStyle(Color.inkLabel)
            }
            .padding(.vertical, 16)
        } else {
            Spacer().frame(height: 16)
        }
    }

    private var pagerRow: some View {
        HStack(spacing: 8) {
            Button { pager.previous() } label: {
                Image(systemName: "chevron.left").font(.system(size: 17, weight: .medium))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .disabled(!PageIndicator.canGoBack(page: pager.page))
            .accessibilityLabel("Vorige pagina")
            if !ax { Spacer(minLength: 0) }
            Text(ax ? PageIndicator.label(page: pager.page, of: pager.count, style: .short)
                    : PageIndicator.label(page: pager.page, of: pager.count, style: .full).uppercased())
                .font(ax ? .display(17, relativeTo: .body) : .mono(12, relativeTo: .caption))
                .monoCap()
                .tracking(ax ? 0 : 1)
                .foregroundStyle(Color.inkLabel)
                .monospacedDigit()
                .accessibilityLabel(PageIndicator.label(page: pager.page, of: pager.count, style: .full))
            if !ax { Spacer(minLength: 0) }
            Button { pager.next() } label: {
                Image(systemName: "chevron.right").font(.system(size: 17, weight: .medium))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .disabled(!PageIndicator.canGoForward(page: pager.page, of: pager.count))
            .accessibilityLabel("Volgende pagina")
        }
        .foregroundStyle(Color.signalLink)
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func notHereBox(_ doc: DossierDoc) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "arrow.down.to.line").font(.system(size: 22, weight: .light))
                .foregroundStyle(Color.inkLabel)
                .accessibilityHidden(true)
            Text("\(DocumentViewerModel.Copy.notHere) · \(DossierLine.size(doc.sizeBytes))")
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(RoundedRectangle(cornerRadius: Radius.panel)
            .strokeBorder(Color.edgeStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 4])))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var bottomAction: some View {
        Group {
            switch model.content {
            case .pdf, .image:
                AuthButton(title: DocumentViewerModel.Copy.counter) { counter = true }
                    .glow(Glow.action)
            case .notHere:
                AuthButton(title: DocumentViewerModel.Copy.takeIn, enabled: !model.isOffline, busy: model.takingIn) {
                    Task { await model.takeIn() }
                }
                .glow(model.isOffline ? Glow.Shadow.none : Glow.action)
            default:
                EmptyView()
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(Color.void.opacity(ax ? 1 : 0))
    }

    @ViewBuilder private var shareButton: some View {
        if let file = SharedDocument(content: model.content, title: shownTitle) {
            ShareLink(item: file, preview: SharePreview(shownTitle)) {
                Image(systemName: "square.and.arrow.up")
            }
            .accessibilityLabel("Deel…")
        } else {
            Image(systemName: "square.and.arrow.up").foregroundStyle(Color.inkFaint)
                .accessibilityHidden(true)
        }
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(.display(15, relativeTo: .subheadline))
            .foregroundStyle(Color.inkMute)
            .multilineTextAlignment(.center)
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

enum ViewerAnchor: Hashable { case title, page }

extension View {
    /// `-fixtures-dossier pagina`: the AX5 viewer scrolled so the page is at
    /// the top ("Document / AX5 · gescrold"). Nothing in a Release build.
    @ViewBuilder func fixtureViewerScroll() -> some View {
        #if DEBUG
        if FixtureLaunch.current?.dossier.contains(.pagina) == true {
            defaultScrollAnchor(.bottom)
        } else { self }
        #else
        self
        #endif
    }
}

extension Glow.Shadow {
    static let none = Glow.Shadow(color: .clear, radius: 0, y: 0)
}

/// A small notice card: a mono label and a line ("GEEN TEKST HERKEND").
struct DossierNotice: View {
    let label: String
    let text: String
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(typeSize.isAccessibilitySize ? HomeSummary.sentence(label) : label.uppercased())
                .font(.mono(12, relativeTo: .caption)).monoCap().tracking(typeSize.isAccessibilitySize ? 0 : 1)
                .foregroundStyle(Color.inkLabel)
            Text(text)
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }
}

/// "Deel…": the shown bytes under the document's own title (the stored file
/// is named by its id), as a temporary copy outside the protected dossier
/// folder, removed again when the viewer goes (`SharedDocument.cleanUp`).
/// Martin's own act — no proposal, no ledger event.
struct SharedDocument: Transferable {
    let fileName: String
    let bytes: @Sendable () async throws -> Data

    init?(content: DocumentViewerModel.Content, title: String) {
        switch content {
        case .pdf(let d): fileName = Self.name(title, ext: "pdf"); bytes = { d }
        case .image(let d): fileName = Self.name(title, ext: "jpg"); bytes = { d }
        default: return nil
        }
    }

    /// A row's long-press "Deel…": the bytes are read from the phone's copy
    /// only when a share is chosen.
    init(store: DossierStore, id: String, title: String) {
        fileName = Self.name(title, ext: "pdf")
        bytes = {
            guard let url = await store.fileURL(id) else { throw CocoaError(.fileNoSuchFile) }
            return try Data(contentsOf: url)
        }
    }

    static let folder = URL.temporaryDirectory.appending(path: "verder-share", directoryHint: .isDirectory)

    /// The title as a file name: no path separators, the extension once.
    static func name(_ title: String, ext: String) -> String {
        let clean = title.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespaces)
        let base = clean.isEmpty ? "document" : clean
        return base.lowercased().hasSuffix(".\(ext)") ? base : "\(base).\(ext)"
    }

    static func cleanUp() { try? FileManager.default.removeItem(at: folder) }

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .data) { doc in
            let data = try await doc.bytes()
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appending(path: doc.fileName)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return SentTransferredFile(url)
        }
    }
}

/// The current page of a PDF on screen, and the buttons that turn it.
@MainActor
@Observable
final class PDFPager {
    private(set) var page = 1
    private(set) var count = 0
    /// The zoom against the fitted page, for "230 %".
    private(set) var scale: CGFloat = 1
    private(set) var fit: CGFloat = 1
    @ObservationIgnored weak var view: PDFView?

    func attach(_ view: PDFView) {
        self.view = view
        update()
    }

    func update() {
        guard let view, let doc = view.document else { return }
        count = doc.pageCount
        if let current = view.currentPage { page = doc.index(for: current) + 1 }
        scale = view.scaleFactor
        fit = view.scaleFactorForSizeToFit
    }

    func next() { view?.goToNextPage(nil); update() }
    func previous() { view?.goToPreviousPage(nil); update() }

    /// Back to the whole page ("dubbeltik: hele pagina").
    func fitPage() {
        guard let view else { return }
        view.scaleFactor = view.scaleFactorForSizeToFit
        view.autoScales = true
        update()
    }

    func zoom(_ factor: CGFloat, at point: CGPoint? = nil) {
        guard let view, let page = view.currentPage else { return }
        view.autoScales = false
        view.scaleFactor = view.scaleFactorForSizeToFit * factor
        if let point {
            let size = CGSize(width: view.bounds.width / view.scaleFactor, height: view.bounds.height / view.scaleFactor)
            view.go(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                               width: size.width, height: size.height), on: page)
        }
        update()
    }

    var isZoomed: Bool { PageIndicator.isZoomed(scale: scale, fit: fit) }
}

/// PDFKit's view: ONE page at a time on `void`, fitted, swiped or paged to
/// the next; pinch to zoom. The pager follows it.
struct PDFKitView: UIViewRepresentable {
    let data: Data
    var pager: PDFPager? = nil
    var label: String = ""
    /// A double tap goes back to the whole page, or zooms in on the tap.
    var doubleTapZooms = false

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePage
        view.displayDirection = .horizontal
        view.usePageViewController(true)
        view.pageShadowsEnabled = false
        view.displaysPageBreaks = false
        view.backgroundColor = .clear
        view.document = PDFDocument(data: data)
        view.isAccessibilityElement = false
        view.accessibilityLabel = label
        context.coordinator.observe(view)
        if doubleTapZooms {
            let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
            tap.numberOfTapsRequired = 2
            view.addGestureRecognizer(tap)
        }
        return view
    }

    /// The bytes never change under one view: a new document is a new
    /// `.pdf` case, and so a new view.
    func updateUIView(_ view: PDFView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(pager: pager) }

    @MainActor
    final class Coordinator: NSObject {
        let pager: PDFPager?

        init(pager: PDFPager?) { self.pager = pager }

        /// Selector observers: removed with the coordinator, no token to keep.
        func observe(_ view: PDFView) {
            guard let pager else { return }
            pager.attach(view)
            for name in [Notification.Name.PDFViewPageChanged, .PDFViewScaleChanged, .PDFViewDocumentChanged] {
                NotificationCenter.default.addObserver(self, selector: #selector(changed), name: name, object: view)
            }
            // The fit is known once the view has its size.
            DispatchQueue.main.async { pager.update() }
        }

        @objc private func changed() { pager?.update() }

        @objc func doubleTapped(_ gesture: UITapGestureRecognizer) {
            guard let pager, let view = pager.view, let page = view.currentPage else { return }
            if pager.isZoomed { pager.fitPage() } else {
                pager.zoom(2.5, at: view.convert(gesture.location(in: view), to: page))
            }
        }
    }
}

/// "Toon aan de balie": the document full screen on black for someone across
/// a counter — no bars, the screen at full brightness until it closes (×,
/// the edge swipe, or the app leaving the foreground), "1 / 2", and zoom
/// with its level said ("230 %") and a double tap back to the whole page.
struct CounterView: View {
    let content: DocumentViewerModel.Content
    let title: String
    @State private var pager = PDFPager()
    @State private var brightness = BrightnessGuard.live()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    static let hint = "helderheid op max · sluit met × of veeg terug"
    static let zoomHint = "dubbeltik: hele pagina"

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            switch content {
            case .pdf(let data):
                PDFKitView(data: data, pager: pager, label: title, doubleTapZooms: true).ignoresSafeArea()
            case .image(let data):
                if let image = UIImage(data: data) { ZoomableImageView(image: image, label: title).ignoresSafeArea() }
            default:
                EmptyView()
            }
        }
        .overlay(alignment: .topTrailing) {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.field))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Sluit")
            .padding(.trailing, 16)
        }
        .overlay(alignment: .topLeading) {
            if pager.isZoomed {
                Label(PageIndicator.zoom(scale: pager.scale, fit: pager.fit), systemImage: "plus.magnifyingglass")
                    .font(.mono(12, relativeTo: .caption)).monoCap()
                    .foregroundStyle(Color.inkBright)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Capsule().fill(Color.field))
                    .padding(.leading, 16).padding(.top, 6)
            }
        }
        .overlay(alignment: .bottom) {
            VStack(spacing: 14) {
                if pager.isZoomed {
                    Text(Self.zoomHint.uppercased())
                } else {
                    if pager.count > 1 {
                        Text(PageIndicator.label(page: pager.page, of: pager.count, style: .counter))
                            .font(.mono(13, relativeTo: .caption, weight: .medium)).monoCap()
                            .foregroundStyle(Color.inkBright)
                            .monospacedDigit()
                            .padding(.horizontal, 14).padding(.vertical, 5)
                            .background(Capsule().fill(Color.field))
                            .accessibilityLabel(PageIndicator.label(page: pager.page, of: pager.count, style: .full))
                    }
                    Text(Self.hint.uppercased())
                }
            }
            .font(.mono(12, relativeTo: .caption)).monoCap()
            .tracking(1)
            .foregroundStyle(Color.inkLabel)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 16)
            .padding(.bottom, 40)
            .allowsHitTesting(false)
        }
        // "veeg terug": a swipe in from the leading edge closes, as Back would.
        .overlay(alignment: .leading) {
            Color.clear.frame(width: 20).contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 20).onEnded { if $0.translation.width > 60 { dismiss() } })
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .preferredColorScheme(.dark)
        .onAppear { brightness.raise() }
        .onDisappear { brightness.restore() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { brightness.raise() } else { brightness.restore() }
        }
        #if DEBUG
        .task {
            guard FixtureLaunch.current?.dossier.contains(.balieZoom) == true else { return }
            try? await Task.sleep(for: .milliseconds(600))
            // The letter's body paragraphs (PDF points, from the bottom).
            pager.zoom(2.3, at: CGPoint(x: 190, y: 440))
        }
        #endif
    }
}

/// The zoom arithmetic of the image viewer, apart from UIKit so it is tested
/// as numbers: open fitted, zoom well past it, double tap in and back.
enum ImageZoom {
    /// The scale at which the whole image fits the viewport (it may grow a
    /// small image, as PDFKit's `autoScales` does).
    static func fitScale(image: CGSize, in viewport: CGSize) -> CGFloat {
        guard image.width > 0, image.height > 0, viewport.width > 0, viewport.height > 0 else { return 1 }
        return min(viewport.width / image.width, viewport.height / image.height)
    }

    /// Far enough to read the small print of a fitted page held up at a
    /// counter: four times the fit, and never less than the image's own
    /// pixels at twice their size.
    static func maxScale(fit: CGFloat) -> CGFloat { max(fit * 4, 2) }

    /// A double tap at the fit zooms in (2.5 x the fit, within the range);
    /// anywhere else it returns to the fit.
    static func doubleTapScale(current: CGFloat, fit: CGFloat, max: CGFloat) -> CGFloat {
        current > fit * 1.01 ? fit : Swift.min(fit * 2.5, max)
    }

    /// The image-space rect a scroll view zooms to so that `point` ends up
    /// in the middle of the viewport at `scale`.
    static func zoomRect(around point: CGPoint, scale: CGFloat, viewport: CGSize) -> CGRect {
        let size = CGSize(width: viewport.width / scale, height: viewport.height / scale)
        return CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                      width: size.width, height: size.height)
    }
}

/// An image, pinch- and double-tap-zoomable, centred while it is smaller
/// than the screen: the image counterpart of `PDFKitView`.
final class ZoomingImageScrollView: UIScrollView, UIScrollViewDelegate {
    let imageView: UIImageView
    /// The bounds the zoom range was last set for; a rotation resets it.
    private var fittedFor: CGSize = .zero

    init(image: UIImage) {
        imageView = UIImageView(image: image)
        super.init(frame: .zero)
        delegate = self
        backgroundColor = .clear
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        decelerationRate = .fast
        bouncesZoom = true
        imageView.frame = CGRect(origin: .zero, size: image.size)
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        addSubview(imageView)
        contentSize = image.size
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != fittedFor, bounds.width > 0, bounds.height > 0 {
            fittedFor = bounds.size
            let fit = ImageZoom.fitScale(image: imageView.bounds.size, in: bounds.size)
            minimumZoomScale = fit
            maximumZoomScale = ImageZoom.maxScale(fit: fit)
            zoomScale = fit
        }
        centre()
    }

    /// Insets that keep an image smaller than the viewport in its middle.
    private func centre() {
        let size = imageView.frame.size
        let v = max((bounds.height - size.height) / 2, 0)
        let h = max((bounds.width - size.width) / 2, 0)
        let insets = UIEdgeInsets(top: v, left: h, bottom: v, right: h)
        if contentInset != insets { contentInset = insets }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { centre() }

    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        toggleZoom(at: gesture.location(in: imageView), animated: true)
    }

    /// `point` is in the image's own coordinates.
    func toggleZoom(at point: CGPoint, animated: Bool) {
        let target = ImageZoom.doubleTapScale(current: zoomScale, fit: minimumZoomScale, max: maximumZoomScale)
        if target <= minimumZoomScale {
            setZoomScale(minimumZoomScale, animated: animated)
        } else {
            zoom(to: ImageZoom.zoomRect(around: point, scale: target, viewport: bounds.size), animated: animated)
        }
    }
}

/// SwiftUI's handle on `ZoomingImageScrollView`.
struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage
    let label: String

    func makeUIView(context: Context) -> ZoomingImageScrollView {
        let view = ZoomingImageScrollView(image: image)
        view.imageView.accessibilityLabel = label
        return view
    }

    /// Like `PDFKitView`: a new image is a new `.image` case, and so a new view.
    func updateUIView(_ view: ZoomingImageScrollView, context: Context) {}
}
