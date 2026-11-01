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

/// The viewer's bytes: the phone's own copy, or — for a server search hit the
/// phone does not hold yet — fetched for this one viewing and never stored.
@MainActor
@Observable
final class DocumentViewerModel {
    enum Content: Equatable {
        case loading
        case pdf(Data)
        case image(Data)
        case unsupported
        case failed(String)
    }

    enum Copy {
        static let unsupported = "Dit soort bestand kan de telefoon niet tonen. Open het in verder op de computer."
        static let gone = "Dit document is er niet meer."
        static let offline = "Dit document staat nog niet op je telefoon, en er is geen verbinding."
        static let failed = "Het document kon niet worden geopend."
    }

    private(set) var content: Content = .loading

    @ObservationIgnored private let id: String
    @ObservationIgnored private let store: DossierStore
    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void

    init(id: String, store: DossierStore, client: APIClient, onUnauthorized: @escaping @MainActor () -> Void) {
        self.id = id
        self.store = store
        self.client = client
        self.onUnauthorized = onUnauthorized
    }

    func load() async {
        if let url = await store.fileURL(id), let data = try? Data(contentsOf: url) {
            content = Self.content(data, contentType: await store.contentType(id))
            return
        }
        guard UUID(uuidString: id) != nil else { content = .failed(Copy.gone); return }
        do {
            let req = client.request("/api/mobile/v1/documents/\(id)/file", method: "GET", body: nil, contentType: nil)
            let (data, http) = try await client.send(req)
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

    static func content(_ data: Data, contentType: String?) -> Content {
        switch ViewerKind(contentType: contentType) {
        case .pdf: .pdf(data)
        case .image: .image(data)
        case .unsupported: .unsupported
        }
    }
}

/// A document, full screen: PDFs through PDFKit, images through
/// `ZoomableImageView` — pinch and double tap on both, so small print can be
/// read at a counter whatever the file type. Pushed on
/// the Dossier stack with the tab bar hidden, so the edge swipe goes back.
/// Read-only: nothing here changes a document, and purge is never offered.
struct DocumentViewer: View {
    let title: String
    @State private var model: DocumentViewerModel

    init(id: String, title: String, store: DossierStore, client: APIClient,
         onUnauthorized: @escaping @MainActor () -> Void) {
        self.title = title
        _model = State(initialValue: DocumentViewerModel(id: id, store: store, client: client,
                                                         onUnauthorized: onUnauthorized))
    }

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            switch model.content {
            case .loading:
                Color.plate.opacity(0.6).ignoresSafeArea(edges: .bottom)
            case .pdf(let data):
                PDFKitView(data: data).ignoresSafeArea(edges: .bottom)
            case .image(let data):
                if let image = UIImage(data: data) {
                    ZoomableImageView(image: image, label: title).ignoresSafeArea(edges: .bottom)
                } else {
                    notice(DocumentViewerModel.Copy.failed)
                }
            case .unsupported:
                notice(DocumentViewerModel.Copy.unsupported)
            case .failed(let message):
                notice(message)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .preferredColorScheme(.dark)
        .task { if model.content == .loading { await model.load() } }
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

/// PDFKit's view: continuous vertical pages, scaled to the width, on `void`.
struct PDFKitView: UIViewRepresentable {
    let data: Data

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = UIColor(Color.void)
        view.document = PDFDocument(data: data)
        return view
    }

    /// The bytes never change under one view: a new document is a new
    /// `.pdf` case, and so a new view.
    func updateUIView(_ view: PDFView, context: Context) {}
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
