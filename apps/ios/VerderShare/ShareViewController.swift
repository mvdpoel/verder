import PDFKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The share extension (spec §7.8, plan 3 Task 22): PDFs, photos and files from
/// any app go into verder's upload queue with source `phone-share`.
///
/// It loads what the share sheet handed over, shows ONE screen (thumbnail,
/// title, Versturen trailing — design brief, share extension row), and on
/// Versturen leaves an `IncomingDrop` for the app and makes one bounded upload
/// attempt of its own (`ShareModel`). It never writes the app's queue.json.
///
/// The session comes from the shared Keychain item (`keychain-access-groups`,
/// with `VerderKeychainAccessGroup` in THIS bundle's Info.plist, because
/// `KeychainSessionStore` reads `Bundle.main`, which here is the extension).
/// Signed out, the attempt simply fails and the app's queue sends it later.
///
/// The spec's optional one-line note is DEFERRED (spec §7.8): there is no field
/// for it on the upload and no column for it on a document.
@MainActor
final class ShareViewController: UIViewController {
    private lazy var model: ShareModel = {
        let group = AppGroup.containerURL
        return ShareModel(groupDir: group) { ids, groupDir in
            let client = APIClient(session: APIClient.makeSession(), store: KeychainSessionStore())
            return await ShareSender.send(ids, groupDir: groupDir, client: client)
        }
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        let host = UIHostingController(rootView: ShareView(
            model: model,
            cancel: { [weak self] in self?.finish(cancelled: true) },
            send: { [weak self] in self?.send() }))
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)

        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        Task {
            var inputs: [SharedInput] = []
            for provider in providers.prefix(10) {
                if let input = await Self.load(provider) { inputs.append(input) }
            }
            model.loaded(inputs)
        }
    }

    private func send() {
        Task {
            await model.commit()
            if case .done = model.phase {
                // Long enough to read one line; the work is already safe on disk.
                try? await Task.sleep(for: .seconds(1.2))
                finish(cancelled: false)
            }
        }
    }

    private func finish(cancelled: Bool) {
        if cancelled {
            extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        } else {
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    // MARK: - Loading what was shared

    /// An image becomes a page of the one photo PDF; a PDF or any other file
    /// keeps its bytes, name and media type.
    static func load(_ provider: NSItemProvider) async -> SharedInput? {
        let types = provider.registeredContentTypes
        if !types.contains(where: { $0.conforms(to: .pdf) }),
           let imageType = types.first(where: { $0.conforms(to: .image) }),
           let data = await loadData(provider, imageType),
           let image = UIImage(data: data) {
            return .image(image)
        }
        let type = types.first { $0.conforms(to: .data) && !$0.conforms(to: .url) }
        if let type, let data = await loadFile(provider, type) {
            return .file(data: data, fileName: fileName(provider.suggestedName, type: type),
                         mime: type.preferredMIMEType ?? "application/octet-stream")
        }
        // Some apps share only a file URL.
        if types.contains(where: { $0.conforms(to: .fileURL) }), let url = await loadFileURL(provider) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return nil }
            let type = UTType(filenameExtension: url.pathExtension) ?? .data
            if type.conforms(to: .image), !type.conforms(to: .pdf), let image = UIImage(data: data) {
                return .image(image)
            }
            return .file(data: data, fileName: url.lastPathComponent,
                         mime: type.preferredMIMEType ?? "application/octet-stream")
        }
        return nil
    }

    /// The suggested name, with the type's extension added when it has none.
    static func fileName(_ suggested: String?, type: UTType) -> String {
        let base = (suggested?.isEmpty == false ? suggested! : "Gedeeld bestand")
        guard (base as NSString).pathExtension.isEmpty, let ext = type.preferredFilenameExtension else { return base }
        return "\(base).\(ext)"
    }

    private static func loadData(_ provider: NSItemProvider, _ type: UTType) async -> Data? {
        await withCheckedContinuation { (c: CheckedContinuation<Data?, Never>) in
            _ = provider.loadDataRepresentation(for: type) { data, _ in c.resume(returning: data) }
        }
    }

    /// The file is deleted when the handler returns, so it is read inside it.
    private static func loadFile(_ provider: NSItemProvider, _ type: UTType) async -> Data? {
        await withCheckedContinuation { (c: CheckedContinuation<Data?, Never>) in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, _ in
                c.resume(returning: url.flatMap { try? Data(contentsOf: $0) })
            }
        }
    }

    private static func loadFileURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { (c: CheckedContinuation<URL?, Never>) in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { item, _ in
                c.resume(returning: item as? URL)
            }
        }
    }
}

/// The one screen. Thin: everything it says comes from `ShareModel`.
struct ShareView: View {
    let model: ShareModel
    let cancel: () -> Void
    let send: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Button(ShareModel.Copy.cancel, action: cancel)
                    .font(.mono(13, relativeTo: .footnote))
                    .foregroundStyle(Color.inkMute)
                    .frame(minHeight: 44)
                Spacer()
                Text(ShareModel.Copy.heading)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                Spacer()
                Button(ShareModel.Copy.send, action: send)
                    .font(.mono(13, relativeTo: .footnote, weight: .medium))
                    .foregroundStyle(model.canSend ? Color.signal : Color.inkLabel)
                    .disabled(!model.canSend)
                    .frame(minHeight: 44)
            }

            if !model.prepared.isEmpty {
                HStack(alignment: .top, spacing: 12) {
                    Thumbnail(file: model.prepared[0])
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.title)
                            .font(.display(17, relativeTo: .body))
                            .foregroundStyle(Color.ink)
                            .lineLimit(2)
                            .truncationMode(.middle)
                        Text(model.detail)
                            .font(.mono(12, relativeTo: .caption))
                            .foregroundStyle(Color.inkLabel)
                    }
                    Spacer(minLength: 0)
                }
                .padding(16)
                .glassPanel()
            }

            if let message = model.message {
                Text(message)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.inkMute)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.void)
        .preferredColorScheme(.dark)
    }
}

private struct Thumbnail: View {
    let file: PreparedShare

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Image(systemName: "doc").font(.system(size: 24)).foregroundStyle(Color.steel)
            }
        }
        .frame(width: 48, height: 64)
        .background(Color.plate)
        .clipShape(RoundedRectangle(cornerRadius: Radius.chip))
        .accessibilityHidden(true)
    }

    private var image: UIImage? {
        guard file.mime == "application/pdf", let page = PDFDocument(data: file.data)?.page(at: 0) else { return nil }
        return page.thumbnail(of: CGSize(width: 96, height: 128), for: .mediaBox)
    }
}
