import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The share extension (spec §7.8, plan 3 Task 22): PDFs, photos and files from
/// any app go into verder's upload queue with source `phone-share`.
///
/// A CALL RECORDING (Added 2026-11-03) does not: shared from any app — a
/// call-recording app, Voice Memos, Files, AirDrop (iOS lets no app record a
/// call on the same iPhone, and the iPhone's built-in call recording is not
/// available in the Netherlands, so a recording is always made elsewhere) — it
/// becomes an audio drop for the voice log and this screen says "Open verder om het
/// gesprek uit te schrijven." (`ShareModel.handedToApp`). Nothing is uploaded.
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
        // Signed out is known before Versturen: the sheet says so and offers
        // Bewaar, rather than discovering it in a 401 after the tap.
        let store = KeychainSessionStore()
        let signedOut = store.load()?.isLive() != true
        return ShareModel(groupDir: group, signedOut: signedOut) { id, groupDir in
            let client = APIClient(session: APIClient.makeSession(), store: store)
            return await ShareSender.sendOne(id, groupDir: groupDir, client: client)
        }
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        let host = UIHostingController(rootView: ShareView(
            model: model,
            cancel: { [weak self] in self?.finish(cancelled: true) },
            send: { [weak self] in self?.send() },
            close: { [weak self] in self?.finish(cancelled: false) },
            retryLoad: { [weak self] in self?.model.retryLoad() }))
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
        // Every item is accounted for: more than ten keeps the first ten and
        // names the rest; one that cannot be read stays an input the screen reports.
        let loading = Array(providers.prefix(model.handedOver(count: providers.count)))
        guard let staging = ShareStaging.makeDirectory() else {
            model.loaded(Array(repeating: .unreadable, count: loading.count))
            return
        }
        stagingDir = staging
        // Bounded (`ShareModel.loadTimeout`): a source that never answers
        // ends in a cause and "Opnieuw proberen", which runs this again.
        model.load {
            await SharePreparation.collect(count: loading.count) { index in
                await Self.load(loading[index], staging: staging)
            }
        }
    }

    private var stagingDir: URL?

    private func send() {
        Task {
            await model.commit()
            let largeText = traitCollection.preferredContentSizeCategory.isAccessibilityCategory
            if case .done = model.phase,
               model.closesByItself(voiceOver: UIAccessibility.isVoiceOverRunning,
                                    switchControl: UIAccessibility.isSwitchControlRunning, largeText: largeText) {
                // Long enough to read the outcome; the work is already safe on disk.
                try? await Task.sleep(for: ShareModel.autoCloseDelay)
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

    /// An image is STAGED on disk and becomes a page of the one photo PDF
    /// later, decoded already downscaled (`PhotoPage`); it is never held as a
    /// full-size `UIImage`. A PDF or any other file keeps its name and media
    /// type and is staged too: measured, then copied, never read into memory
    /// (`ShareStaging`).
    static func load(_ provider: NSItemProvider, staging: URL) async -> SharedInput? {
        let types = provider.registeredContentTypes
        // A web link (Safari, a link in Mail) is answered as a link: verder
        // keeps files only. A text rendering offered beside it is not a file
        // Martin chose, so it does not travel as one.
        if types.contains(where: { $0.conforms(to: .url) && !$0.conforms(to: .fileURL) }),
           !types.contains(where: { $0.conforms(to: .data) && !$0.conforms(to: .text) && !$0.conforms(to: .url) }) {
            return await loadLink(provider)
        }
        if !types.contains(where: { $0.conforms(to: .pdf) }),
           let imageType = types.first(where: { $0.conforms(to: .image) }) {
            let name = fileName(provider.suggestedName, type: imageType)
            let mime = imageType.preferredMIMEType ?? "application/octet-stream"
            if let input = await loadPhoto(provider, imageType, name: name, mime: mime, staging: staging) {
                return input
            }
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
            if type.conforms(to: .image), !type.conforms(to: .pdf) {
                return ShareStaging.stagePhoto(url, fileName: url.lastPathComponent, mime: mime, into: staging)
            }
            return ShareStaging.stage(url, fileName: url.lastPathComponent, mime: mime, into: staging,
                                      maxBytes: ShareModel.limit(fileName: url.lastPathComponent, mime: mime))
        }
        return nil
    }

    /// The suggested name, with the type's extension added when it has none.
    static func fileName(_ suggested: String?, type: UTType) -> String {
        let base = (suggested?.isEmpty == false ? suggested! : "Gedeeld bestand")
        guard (base as NSString).pathExtension.isEmpty, let ext = type.preferredFilenameExtension else { return base }
        return "\(base).\(ext)"
    }

    /// The photo as a FILE, staged inside the handler (the system deletes it
    /// when the handler returns). Only when a provider offers no file is the
    /// data representation taken, and then only under the file limit, written
    /// to staging and let go at once.
    private static func loadPhoto(_ provider: NSItemProvider, _ type: UTType, name: String, mime: String,
                                  staging: URL) async -> SharedInput? {
        let staged = await withCheckedContinuation { (c: CheckedContinuation<SharedInput?, Never>) in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, _ in
                c.resume(returning: url.map { ShareStaging.stagePhoto($0, fileName: name, mime: mime, into: staging) })
            }
        }
        if let staged { return staged }
        return await withCheckedContinuation { (c: CheckedContinuation<SharedInput?, Never>) in
            _ = provider.loadDataRepresentation(for: type) { data, _ in
                guard let data else { return c.resume(returning: nil) }
                guard data.count <= ShareModel.maxFileBytes else {
                    return c.resume(returning: .tooLarge(fileName: name, bytes: data.count))
                }
                let ext = type.preferredFilenameExtension ?? "img"
                let temp = staging.appending(path: "data-\(UUID().uuidString).\(ext)")
                guard (try? data.write(to: temp)) != nil else { return c.resume(returning: nil) }
                let input = ShareStaging.stagePhoto(temp, fileName: name, mime: mime, into: staging)
                try? FileManager.default.removeItem(at: temp)
                c.resume(returning: input)
            }
        }
    }

    /// The file is deleted when the handler returns, so it is staged inside
    /// it: measured first, copied, never read.
    private static func loadFile(_ provider: NSItemProvider, _ type: UTType, name: String, mime: String,
                                 staging: URL) async -> SharedInput? {
        await withCheckedContinuation { (c: CheckedContinuation<SharedInput?, Never>) in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, _ in
                // A call recording may be larger than a document
                // (`ShareModel.maxAudioBytes`); it is copied, never read.
                c.resume(returning: url.map {
                    ShareStaging.stage($0, fileName: name, mime: mime, into: staging,
                                       maxBytes: ShareModel.limit(fileName: name, mime: mime))
                })
            }
        }
    }

    private static func loadLink(_ provider: NSItemProvider) async -> SharedInput? {
        await withCheckedContinuation { (c: CheckedContinuation<SharedInput?, Never>) in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in
                let url = (item as? URL) ?? (item as? String).flatMap(URL.init(string:))
                c.resume(returning: url.map { .link($0.absoluteString) })
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
