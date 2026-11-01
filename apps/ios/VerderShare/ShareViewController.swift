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
            send: { [weak self] in self?.send() },
            close: { [weak self] in self?.finish(cancelled: false) }))
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
        // Every item is accounted for: too many refuses the share, and one
        // that cannot be read stays an input the screen reports.
        guard model.handedOver(count: providers.count) else { return }
        guard let staging = ShareStaging.makeDirectory() else {
            model.loaded(Array(repeating: .unreadable, count: providers.count))
            return
        }
        stagingDir = staging
        Task {
            let inputs = await SharePreparation.collect(count: providers.count) { index in
                await Self.load(providers[index], staging: staging)
            }
            model.loaded(inputs)
        }
    }

    private var stagingDir: URL?

    private func send() {
        Task {
            await model.commit()
            if case .done = model.phase, model.closesByItself {
                // Long enough to read one line; the work is already safe on disk.
                try? await Task.sleep(for: .seconds(1.2))
                finish(cancelled: false)
            }
        }
    }

    private func finish(cancelled: Bool) {
        // The drops hold their own copies; the staged files are only ours.
        if let stagingDir { try? FileManager.default.removeItem(at: stagingDir) }
        if cancelled {
            extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        } else {
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    // MARK: - Loading what was shared

    /// An image becomes a page of the one photo PDF; a PDF or any other file
    /// keeps its name and media type and is STAGED: measured, then copied,
    /// never read into memory (`ShareStaging`).
    static func load(_ provider: NSItemProvider, staging: URL) async -> SharedInput? {
        let types = provider.registeredContentTypes
        if !types.contains(where: { $0.conforms(to: .pdf) }),
           let imageType = types.first(where: { $0.conforms(to: .image) }),
           let data = await loadData(provider, imageType),
           let image = UIImage(data: data) {
            return .image(image)
        }
        let type = types.first { $0.conforms(to: .data) && !$0.conforms(to: .url) }
        if let type {
            let name = fileName(provider.suggestedName, type: type)
            let mime = type.preferredMIMEType ?? "application/octet-stream"
            if let input = await loadFile(provider, type, name: name, mime: mime, staging: staging) {
                return input
            }
        }
        // Some apps share only a file URL.
        if types.contains(where: { $0.conforms(to: .fileURL) }), let url = await loadFileURL(provider) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let type = UTType(filenameExtension: url.pathExtension) ?? .data
            let mime = type.preferredMIMEType ?? "application/octet-stream"
            if type.conforms(to: .image), !type.conforms(to: .pdf),
               let size = ShareStaging.byteCount(url), size <= ShareModel.maxFileBytes,
               let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                return .image(image)
            }
            return ShareStaging.stage(url, fileName: url.lastPathComponent, mime: mime, into: staging)
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

    /// The file is deleted when the handler returns, so it is staged inside
    /// it: measured first, copied, never read.
    private static func loadFile(_ provider: NSItemProvider, _ type: UTType, name: String, mime: String,
                                 staging: URL) async -> SharedInput? {
        await withCheckedContinuation { (c: CheckedContinuation<SharedInput?, Never>) in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, _ in
                c.resume(returning: url.map { ShareStaging.stage($0, fileName: name, mime: mime, into: staging) })
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
    let close: () -> Void

    private var isDone: Bool {
        if case .done = model.phase { true } else { false }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                // Only while cancelling is true (`ShareModel.canCancel`); the
                // done state offers Sluiten alone.
                if model.canCancel {
                    Button(ShareModel.Copy.cancel, action: cancel)
                        .font(.mono(13, relativeTo: .footnote))
                        .foregroundStyle(Color.inkMute)
                        .frame(minHeight: 44)
                }
                Spacer()
                Text(ShareModel.Copy.heading)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                Spacer()
                if isDone {
                    Button(ShareModel.Copy.close, action: close)
                        .font(.mono(13, relativeTo: .footnote, weight: .medium))
                        .foregroundStyle(Color.signal)
                        .frame(minHeight: 44)
                } else {
                    Button(ShareModel.Copy.send, action: send)
                        .font(.mono(13, relativeTo: .footnote, weight: .medium))
                        .foregroundStyle(model.canSend ? Color.signal : Color.inkLabel)
                        .disabled(!model.canSend)
                        .frame(minHeight: 44)
                }
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

            if let warning = model.warning {
                Text(warning)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.ink)
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
        guard file.mime == "application/pdf" else { return nil }
        let document: PDFDocument? = switch file.content {
        case .data(let data): PDFDocument(data: data)
        case .file(let url): PDFDocument(url: url)
        }
        return document?.page(at: 0)?.thumbnail(of: CGSize(width: 96, height: 128), for: .mediaBox)
    }
}
