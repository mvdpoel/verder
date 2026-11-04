#if DEBUG
import SwiftUI
import UIKit

/// A SHARE HOST for the captures (`scripts/capture.sh <fixture> share:<scene>`).
/// A share extension only runs inside another app's share sheet, which the
/// simulator cannot be told to open from the shell. So this presents the REAL
/// `ShareView` on a real `ShareModel`, driven down the same paths the
/// extension takes (load, commit, the sender's answer), in a sheet the way iOS
/// presents an extension. The `deelblad` scene opens the system share sheet
/// itself on a synthetic PDF.
///
/// Only the sheet around the view is imitated; the screen in it is the product.
/// Every file is drawn here, synthetic (docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md).
///
///     -share-host <scene>   one of `ShareHostScene` (with -fixtures)
///     -fixtures-scroll end  opens the sheet scrolled to its end
enum ShareHostScene: String, CaseIterable, Sendable {
    case deelblad, laden
    case ladenFout = "laden-fout"
    case eenPDF = "een-pdf"
    case eenPDFLang = "een-pdf-lang"
    case fotos, meerdere
    case meerdereDeels = "meerdere-deels"
    case meerDan10 = "meer-dan-10"
    case versturen
    case versturenFout = "versturen-fout"
    case verstuurd
    case bewaardOffline = "bewaard-offline"
    case bewaardGroot = "bewaard-groot"
    case nietIngelogd = "niet-ingelogd"
    case bewaard
    case nietOndersteund = "niet-ondersteund"
    case teGroot = "te-groot"

    /// Nil unless the app runs on fixtures with `-share-host`; a scene name
    /// it cannot read is a crash, so capture.sh never shoots the wrong one.
    static let current: ShareHostScene? = {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-fixtures"), let i = args.firstIndex(of: "-share-host"), i + 1 < args.count else {
            return nil
        }
        guard let scene = ShareHostScene(rawValue: args[i + 1]) else {
            fatalError("-share-host: unknown scene '\(args[i + 1])'")
        }
        return scene
    }()

    static var scrolledToEnd: Bool {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-fixtures-scroll"), i + 1 < args.count else { return false }
        return args[i + 1] == "end"
    }
}

struct ShareHostView: View {
    let scene: ShareHostScene
    @State private var model: ShareModel?

    var body: some View {
        if scene == .deelblad {
            ShareSheetHost()
        } else {
            Color.black.ignoresSafeArea()
                .sheet(isPresented: .constant(true)) {
                    Group {
                        if let model {
                            ShareView(model: model, cancel: {}, send: { Task { await model.commit() } }, close: {},
                                      retryLoad: { model.retryLoad() }, startsAtEnd: ShareHostScene.scrolledToEnd)
                        } else {
                            Color.plate
                        }
                    }
                    .presentationDragIndicator(.visible)
                    .presentationBackground(Color.plate)
                    .interactiveDismissDisabled()
                }
                .task { model = ShareHostData.model(for: scene) }
        }
    }
}

/// The models, built as the extension builds them.
@MainActor
enum ShareHostData {
    /// Sun 1 nov 2026 14:02 Amsterdam (13:02 UTC).
    static let clock = Date(timeIntervalSince1970: 1_793_538_120)

    static let bevestiging = "Bevestiging aanmelding Noordkust 30 okt.pdf"
    static let briefLang = "Brief Gemeente Westerlaan over de aanvullende bijzondere bijstand 30 okt.pdf"
    static let polis = "Polis Duinzorg 2026.pdf"
    static let jaaropgaaf = "Jaaropgaaf 2025 scan.pdf"
    static let afschrift = "Afschrift september.pdf"

    static func model(for scene: ShareHostScene) -> ShareModel {
        let group = dir("group")
        func make(signedOut: Bool = false, sourceApp: String? = nil, now: Date = clock,
                  writeDrop: @escaping ShareModel.DropWriter = ShareModel.writeDrop,
                  answer: ShareSendResult = .sent, hang: Bool = false) -> ShareModel {
            ShareModel(groupDir: group, signedOut: signedOut, sourceApp: sourceApp,
                       sendBound: hang ? .seconds(100_000) : .seconds(20), now: { now }, writeDrop: writeDrop) { _, _ in
                if hang { try? await Task.sleep(for: .seconds(100_000)) }
                return answer
            }
        }
        switch scene {
        case .deelblad, .laden:
            let m = make()
            m.handedOver(count: 1)
            m.load(timeout: .seconds(100_000)) { await never() }
            return m
        case .ladenFout:
            let m = make(sourceApp: "Mail")
            m.handedOver(count: 1)
            m.load(timeout: .milliseconds(50)) { await never() }
            return m
        case .eenPDF: return loaded(make(), [letter(bevestiging, pages: 2, bytes: 312_000)])
        case .eenPDFLang: return loaded(make(), [letter(briefLang, pages: 1, bytes: 296_000)])
        case .fotos: return loaded(make(), photos(3))
        case .meerdere:
            return loaded(make(), [letter(bevestiging, pages: 2, bytes: 312_000), letter(polis, pages: 4, bytes: 488_000),
                                   letter(briefLang, pages: 1, bytes: 296_000)])
        case .meerdereDeels:
            return loaded(make(), [letter(bevestiging, pages: 2, bytes: 312_000), tooLarge(jaaropgaaf),
                                   letter(polis, pages: 4, bytes: 488_000)])
        case .meerDan10:
            let m = make(now: clock.addingTimeInterval(240))
            m.handedOver(count: 14)
            m.loaded(photos(10))
            return m
        case .versturen:
            let m = loaded(make(hang: true), photos(3))
            Task { await m.commit() }
            return m
        case .versturenFout:
            let m = loaded(make(writeDrop: { _, _, _ in throw CocoaError(.fileWriteOutOfSpace) }), photos(3))
            Task { await m.commit() }
            return m
        case .verstuurd: return committed(make(answer: .sent), [letter(bevestiging, pages: 2, bytes: 312_000)])
        case .bewaardOffline:
            return committed(make(answer: .offline), [letter(bevestiging, pages: 2, bytes: 312_000)])
        case .bewaardGroot:
            return committed(make(answer: .tooLargeForExtension), [letter(afschrift, pages: 3, bytes: 14_000_000)])
        case .nietIngelogd: return loaded(make(signedOut: true), [letter(bevestiging, pages: 2, bytes: 312_000)])
        case .bewaard: return committed(make(signedOut: true), [letter(bevestiging, pages: 2, bytes: 312_000)])
        case .nietOndersteund: return loaded(make(), [.link("https://westerlaan.example/bijstand")])
        case .teGroot: return loaded(make(), [tooLarge(jaaropgaaf)])
        }
    }

    private static func loaded(_ m: ShareModel, _ inputs: [SharedInput]) -> ShareModel {
        m.handedOver(count: inputs.count)
        m.loaded(inputs)
        return m
    }

    private static func committed(_ m: ShareModel, _ inputs: [SharedInput]) -> ShareModel {
        _ = loaded(m, inputs)
        Task { await m.commit() }
        return m
    }

    private static func never() async -> [SharedInput] {
        try? await Task.sleep(for: .seconds(100_000))
        return []
    }

    static func dir(_ name: String) -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "share-host/\(name)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// A staged PDF of drawn letter pages, reported at `bytes` (the size the
    /// frame states; the drawn file itself is a few kB).
    static func letter(_ name: String, pages: Int, bytes: Int) -> SharedInput {
        let url = dir("files").appending(path: name)
        try? letterPDF(pages: pages).write(to: url)
        return .staged(url: url, fileName: name, mime: "application/pdf", bytes: bytes)
    }

    static func tooLarge(_ name: String) -> SharedInput {
        let url = dir("large").appending(path: name)
        try? letterPDF(pages: 1).write(to: url)
        return .tooLarge(fileName: name, bytes: 62_000_000, thumbnail: ShareStaging.firstPageThumbnail(url))
    }

    /// Photos of letter pages, staged as JPEGs: they go through the real
    /// photo PDF (`SharePreparation.prepare`).
    static func photos(_ count: Int) -> [SharedInput] {
        (0..<count).map { i in
            let url = dir("photos").appending(path: "foto-\(i).jpg")
            let image = UIGraphicsImageRenderer(size: CGSize(width: 1240, height: 1754)).image { ctx in
                drawPage(ctx.cgContext, size: CGSize(width: 1240, height: 1754), seed: i)
            }
            try? image.jpegData(compressionQuality: 0.85)?.write(to: url)
            return .photo(url: url)
        }
    }

    static func letterPDF(pages: Int) -> Data {
        let size = CGSize(width: 595, height: 842)
        return UIGraphicsPDFRenderer(bounds: CGRect(origin: .zero, size: size)).pdfData { ctx in
            for page in 0..<pages {
                ctx.beginPage()
                drawPage(ctx.cgContext, size: size, seed: page)
            }
        }
    }

    /// A letter as the frames draw it: a pale page, a blue sender block, an
    /// address, a bold subject line and paragraphs of grey bars. No words.
    static func drawPage(_ c: CGContext, size: CGSize, seed: Int) {
        let s = size.width / 595
        c.setFillColor(UIColor(red: 0.93, green: 0.96, blue: 0.99, alpha: 1).cgColor)
        c.fill(CGRect(origin: .zero, size: size))
        func bar(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat = 7, _ grey: CGFloat = 0.55) {
            c.setFillColor(UIColor(white: grey, alpha: 1).cgColor)
            c.fill(CGRect(x: x * s, y: y * s, width: w * s, height: h * s))
        }
        c.setFillColor(UIColor(red: 0.58, green: 0.71, blue: 0.84, alpha: 1).cgColor)
        c.fill(CGRect(x: 56 * s, y: 60 * s, width: 100 * s, height: 40 * s))
        bar(56, 128, 200); bar(56, 146, 160); bar(56, 164, 130)
        bar(380, 226, 160)
        bar(56, 280, 300, 11, 0.25)
        var y: CGFloat = 330
        let widths: [CGFloat] = [480, 460, 470, 300, 0, 480, 440, 470, 380, 0, 480, 470, 450, 260, 0, 470, 210]
        for (i, w) in widths.enumerated() {
            if w > 0 { bar(56, y, w - CGFloat((seed + i) % 3) * 20) }
            y += w > 0 ? 20 : 26
        }
    }
}

/// The system share sheet, opened on a synthetic PDF over a drawn mail.
private struct ShareSheetHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { SheetPresenter() }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}

    final class SheetPresenter: UIViewController {
        private var presented = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = UIColor(Color.void)
            let host = UIHostingController(rootView: MailBehind())
            host.view.backgroundColor = .clear
            addChild(host)
            host.view.frame = view.bounds
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(host.view)
            host.didMove(toParent: self)
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard !presented else { return }
            presented = true
            let url = ShareHostData.dir("deelblad").appending(path: "Brief Gemeente Westerlaan 30 okt.pdf")
            try? ShareHostData.letterPDF(pages: 2).write(to: url)
            present(UIActivityViewController(activityItems: [url], applicationActivities: nil), animated: false)
        }
    }

    /// The mail the PDF came in, as the frame draws it behind the sheet.
    private struct MailBehind: View {
        var body: some View {
            VStack(alignment: .leading, spacing: 8) {
                Label("Inkomend", systemImage: "chevron.left")
                    .font(.display(17, relativeTo: .body)).foregroundStyle(Color.inkMute)
                    .padding(.bottom, 24)
                Text("Gemeente Westerlaan").font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkSoft)
                Text("30 okt 2026 · 09:12").font(.mono(13)).foregroundStyle(Color.inkLabel)
                Text("Uw aanvraag bijzondere bijstand").font(.display(22, relativeTo: .title2))
                    .foregroundStyle(Color.inkBright).padding(.top, 8)
                Text("Geachte heer/mevrouw, in de bijlage vindt u onze brief over uw aanvraag.")
                    .font(.display(15, relativeTo: .callout)).foregroundStyle(Color.inkMute)
                Label("Brief Gemeente Westerlaan 30 okt.pdf", systemImage: "doc")
                    .font(.display(15, relativeTo: .callout)).foregroundStyle(Color.inkMute).padding(.top, 16)
                Spacer()
            }
            .padding(.horizontal, 28)
            .padding(.top, 60)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.void)
            .preferredColorScheme(.dark)
        }
    }
}
#endif
