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

/// A document, full screen: PDFs through PDFKit, images zoomable. Pushed on
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
                    ScrollView([.horizontal, .vertical]) {
                        Image(uiImage: image).resizable().scaledToFit()
                            .containerRelativeFrame(.horizontal)
                            .accessibilityLabel(title)
                    }
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
