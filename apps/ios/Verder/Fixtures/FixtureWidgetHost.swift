#if DEBUG
import SwiftUI
import UIKit
import WidgetKit

/// A WIDGET HOST for the captures (`scripts/capture.sh <fixture> widget:<scene>`).
/// The simulator cannot be told from the shell to place a widget on its home
/// screen, lock screen or StandBy, so this draws the surface the Figma
/// "widgets · final" frame shows — wallpaper, app icons, dock, clock — around
/// the REAL widget faces (`WidgetFamilyView`, `HeadlineFace`, the same views
/// the extension renders), at the frame's sizes, on `WidgetSamples`.
///
/// What only iOS does is imitated and is NOT the product: the tinted and clear
/// home screens' recolouring, StandBy's night red, the lock screen's vibrant
/// white, the Today View's chrome. The faces under it are the product.
///
///     -widget-host <scene>   one of `WidgetHostScene` (with -fixtures)
enum WidgetHostScene: String, CaseIterable, Sendable {
    case thuisVolleKleur = "thuis-volle-kleur", thuisGetint = "thuis-getint", thuisHelder = "thuis-helder"
    case thuisLeeg = "thuis-leeg", thuisLeegGetint = "thuis-leeg-getint", thuisEenItem = "thuis-een-item"
    case thuisVerouderd = "thuis-verouderd", thuisAfgemeld = "thuis-afgemeld"
    case grootVolleKleur = "groot-volle-kleur", grootGetint = "groot-getint", grootHelder = "groot-helder"
    case grootLeeg = "groot-leeg", grootVerouderd = "groot-verouderd", grootAfgemeld = "groot-afgemeld"
    case vandaag = "vandaag-vergrendeld"
    case toegangWacht = "toegang-wacht", toegangEenItem = "toegang-een-item", toegangLeeg = "toegang-leeg"
    case toegangVerouderd = "toegang-verouderd", toegangAfgemeld = "toegang-afgemeld"
    case standbyOntgrendeld = "standby-ontgrendeld", standbyVergrendeld = "standby-vergrendeld"
    case standbyNacht = "standby-nacht", standbyLeeg = "standby-leeg", standbyVerouderd = "standby-verouderd"
    case standbyAfgemeld = "standby-afgemeld"

    /// Nil unless the app runs on fixtures with `-widget-host`; a scene name
    /// it cannot read is a crash, so capture.sh never shoots the wrong one.
    static let current: WidgetHostScene? = {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-fixtures"), let i = args.firstIndex(of: "-widget-host"), i + 1 < args.count else {
            return nil
        }
        guard let scene = WidgetHostScene(rawValue: args[i + 1]) else {
            fatalError("-widget-host: unknown scene '\(args[i + 1])'")
        }
        return scene
    }()

    enum Surface { case home, large, today, lock, standBy }
    enum Mode { case fullColor, tinted, clear, night }

    var surface: Surface {
        switch self {
        case .grootVolleKleur, .grootGetint, .grootHelder, .grootLeeg, .grootVerouderd, .grootAfgemeld: .large
        case .vandaag: .today
        case .toegangWacht, .toegangEenItem, .toegangLeeg, .toegangVerouderd, .toegangAfgemeld: .lock
        case .standbyOntgrendeld, .standbyVergrendeld, .standbyNacht, .standbyLeeg, .standbyVerouderd,
             .standbyAfgemeld: .standBy
        default: .home
        }
    }

    var mode: Mode {
        switch self {
        case .thuisGetint, .thuisLeegGetint, .grootGetint: .tinted
        case .thuisHelder, .grootHelder: .clear
        case .standbyNacht: .night
        default: .fullColor
        }
    }

    var locked: Bool { self == .vandaag || self == .standbyVergrendeld }
    var signedOut: Bool { [.thuisAfgemeld, .grootAfgemeld, .toegangAfgemeld, .standbyAfgemeld].contains(self) }

    var snapshot: WidgetSnapshot? {
        switch self {
        case .grootVolleKleur, .grootGetint, .grootHelder: WidgetSamples.many
        case .thuisLeeg, .thuisLeegGetint, .grootLeeg, .toegangLeeg, .standbyLeeg: WidgetSamples.empty
        case .thuisEenItem, .toegangEenItem: WidgetSamples.one
        case .thuisVerouderd, .grootVerouderd, .toegangVerouderd, .standbyVerouderd: WidgetSamples.stale
        case .thuisAfgemeld, .grootAfgemeld, .toegangAfgemeld, .standbyAfgemeld: nil
        default: WidgetSamples.few
        }
    }

    /// StandBy's right stack is the system clock in the stale and signed-out
    /// frames, "Waar het nu op wacht" in the rest.
    var standByClock: Bool { self == .standbyVerouderd || self == .standbyAfgemeld }
}

struct WidgetHostView: View {
    let scene: WidgetHostScene
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        GeometryReader { geo in
            let m = HostMetrics(width: geo.size.width)
            ZStack(alignment: .topLeading) {
                switch scene.surface {
                case .home: homeScreen(m)
                case .large: largeScreen(m)
                case .today: todayView(m)
                case .lock: lockScreen(m)
                case .standBy: standBy(geo.size)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
        }
        .ignoresSafeArea()
        .statusBarHidden(scene.surface == .standBy)
        .persistentSystemOverlays(scene.surface == .standBy ? .hidden : .automatic)
        .environment(\.colorScheme, .dark)
    }

    // MARK: Widgets

    private func content(_ family: WidgetFamily, size: CGSize, standBy: Bool = false) -> WidgetContent {
        WidgetContent.make(snapshot: scene.snapshot, family: family, now: WidgetSamples.today,
                           signedOut: scene.signedOut,
                           layout: .make(family: family, displaySize: size, accessibilitySize: typeSize.isAccessibilitySize),
                           standBy: standBy)
    }

    private var renderingMode: WidgetRenderingMode {
        switch scene.mode {
        case .fullColor, .night: .fullColor
        case .tinted, .clear: .accented
        }
    }

    /// One widget at its frame size, with its content margins and its plate.
    private func widget(_ family: WidgetFamily, _ size: CGSize, radius: CGFloat) -> some View {
        WidgetFamilyView(content: content(family, size: size), family: family)
            .padding(16)
            .frame(width: size.width, height: size.height)
            .environment(\.widgetRenderingMode, renderingMode)
            .redacted(reason: scene.locked ? .privacy : [])
            .modifier(Recolour(mode: scene.mode))
            .background(plate(radius))
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    @ViewBuilder private func plate(_ radius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        switch scene.mode {
        case .tinted:
            shape.fill(Color(red: 0.06, green: 0.13, blue: 0.09).opacity(0.9))
                .overlay(shape.strokeBorder(Color(red: 0.4, green: 0.8, blue: 0.5).opacity(0.25)))
        case .clear:
            shape.fill(.ultraThinMaterial).overlay(shape.fill(Color.black.opacity(0.28)))
                .overlay(shape.strokeBorder(Color.white.opacity(0.25)))
        default:
            shape.fill(Color.plate).overlay(shape.strokeBorder(Color.edge))
        }
    }

    // MARK: Home screen

    private func homeScreen(_ m: HostMetrics) -> some View {
        ZStack(alignment: .topLeading) {
            Wallpaper(mode: scene.mode)
            widget(.systemSmall, CGSize(width: m.small, height: m.small), radius: m.radius)
                .offset(x: m.margin, y: m.top)
            AppIcon(app: .agenda, mode: scene.mode, size: m.icon).position(m.icon(col: 2, y: m.top))
            AppIcon(app: .fotos, mode: scene.mode, size: m.icon).position(m.icon(col: 3, y: m.top))
            AppIcon(app: .camera, mode: scene.mode, size: m.icon).position(m.icon(col: 2, y: m.top + m.pitch))
            AppIcon(app: .verder, mode: scene.mode, size: m.icon).position(m.icon(col: 3, y: m.top + m.pitch))
            widget(.systemMedium, CGSize(width: m.wide, height: m.small), radius: m.radius)
                .offset(x: m.margin, y: m.mediumTop)
            iconRows(m, from: m.mediumTop + m.small + m.gap, rows: m.se ? [Self.row2] : [Self.row2, Self.row3, Self.row4])
            Dock(m: m, mode: scene.mode)
        }
    }

    private func largeScreen(_ m: HostMetrics) -> some View {
        ZStack(alignment: .topLeading) {
            Wallpaper(mode: scene.mode)
            widget(.systemLarge, CGSize(width: m.wide, height: m.largeHeight), radius: m.radius)
                .offset(x: m.margin, y: m.top)
            iconRows(m, from: m.top + m.largeHeight + m.gap, rows: [Self.row1, Self.row2, Self.row3])
            Dock(m: m, mode: scene.mode)
        }
    }

    static let row1: [HostApp] = [.agenda, .fotos, .camera, .verder]
    static let row2: [HostApp] = [.klok, .notities, .instellingen, .mail]
    static let row3: [HostApp] = [.kaarten, .weer, .wallet, .gezondheid]
    static let row4: [HostApp] = [.rekenmachine, .podcasts, .bestanden, .herinneringen]

    private func iconRows(_ m: HostMetrics, from y: CGFloat, rows: [[HostApp]]) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(rows.enumerated()), id: \.offset) { r, row in
                ForEach(Array(row.enumerated()), id: \.offset) { c, app in
                    AppIcon(app: app, mode: scene.mode, size: m.icon)
                        .position(m.icon(col: c, y: y + CGFloat(r) * m.pitch))
                }
            }
        }
    }

    // MARK: Today View (locked)

    private func todayView(_ m: HostMetrics) -> some View {
        ZStack(alignment: .topLeading) {
            LinearGradient(colors: [Color(red: 0.05, green: 0.07, blue: 0.11), Color(red: 0.02, green: 0.03, blue: 0.06)],
                           startPoint: .top, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 2) {
                Text("maandag 2 november").font(.system(size: 28, weight: .bold)).foregroundStyle(.white)
                Label("Vergrendeld", systemImage: "lock.fill").font(.system(size: 15))
                    .foregroundStyle(.white.opacity(0.6))
            }
            .offset(x: m.margin, y: 72)
            widget(.systemMedium, CGSize(width: m.wide, height: m.small), radius: m.radius)
                .offset(x: m.margin, y: 145)
            widget(.systemLarge, CGSize(width: m.wide, height: m.largeHeight), radius: m.radius)
                .offset(x: m.margin, y: 145 + m.small + 24)
            Text("Wijzig").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                .padding(.horizontal, 20).padding(.vertical, 8)
                .background(Capsule().fill(Color.white.opacity(0.16)))
                .position(x: m.width / 2, y: 145 + m.small + 24 + m.largeHeight + 44)
        }
    }

    // MARK: Lock screen

    private func lockScreen(_ m: HostMetrics) -> some View {
        let circle = CGSize(width: 72, height: 72)
        let rect = CGSize(width: 160, height: 72)
        return ZStack(alignment: .topLeading) {
            Wallpaper(mode: .fullColor)
            HStack(spacing: 6) {
                Text("ma 2 nov")
                WidgetFamilyView(content: content(.accessoryInline, size: .zero), family: .accessoryInline)
            }
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(Color.white.opacity(0.78))
            .frame(width: m.width)
            .offset(y: 78)
            Text("9:41")
                .font(.system(size: 100, weight: .bold, design: .rounded))
                .foregroundStyle(Color.white.opacity(0.85))
                .frame(width: m.width)
                .offset(y: 100)
            accessory(.accessoryCircular, circle).offset(x: 79, y: 228)
            accessory(.accessoryRectangular, rect).offset(x: 163, y: 228)
            lockButton("flashlight.off.fill").position(x: 71, y: 795)
            lockButton("camera.fill").position(x: m.width - 71, y: 795)
            Capsule().fill(Color.white.opacity(0.9)).frame(width: 134, height: 5)
                .position(x: m.width / 2, y: 862)
        }
    }

    private func accessory(_ family: WidgetFamily, _ size: CGSize) -> some View {
        WidgetFamilyView(content: content(family, size: size), family: family)
            .frame(width: size.width, height: size.height)
            .environment(\.widgetRenderingMode, .vibrant)
            .foregroundStyle(Color.white.opacity(0.92))
            .background {
                // AccessoryWidgetBackground draws nothing outside WidgetKit.
                if family == .accessoryCircular { Circle().fill(Color.white.opacity(0.16)) }
            }
    }

    private func lockButton(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(.white)
            .frame(width: 50, height: 50).background(Circle().fill(Color.white.opacity(0.14)))
    }

    // MARK: StandBy

    /// StandBy is landscape and the capture is portrait: the 874 × 402 scene is
    /// drawn turned a quarter counter-clockwise, and capture.sh turns the PNG back.
    private func standBy(_ screen: CGSize) -> some View {
        let w = max(screen.width, screen.height), h = min(screen.width, screen.height)
        let box = CGSize(width: 175, height: 155)
        let scale: CGFloat = 2
        // The right stack is a little wider: StandBy gives each stack half of
        // the 874 pt screen, and the frame's right column is 377 pt.
        let right = CGSize(width: 200, height: box.height)
        return ZStack(alignment: .topLeading) {
            WidgetFamilyView(content: content(.systemSmall, size: box, standBy: true), family: .systemSmall,
                             standBy: true)
                .frame(width: box.width, height: box.height)
                .redacted(reason: scene.locked ? .privacy : [])
                .scaleEffect(scale, anchor: .topLeading)
                .offset(x: 40, y: 44)
            if scene.standByClock {
                VStack(alignment: .leading, spacing: 18) {
                    Text("9:41").font(.system(size: 116, weight: .bold, design: .rounded))
                        .foregroundStyle(Color(white: 0.82))
                    Text("maandag 2 november").font(.system(size: 20)).foregroundStyle(Color(white: 0.55))
                }
                .offset(x: w / 2 + 20, y: 190)
            } else {
                HeadlineFace(content: HeadlineContent.make(snapshot: scene.snapshot, now: WidgetSamples.today,
                                                           signedOut: scene.signedOut), standBy: true)
                    .frame(width: right.width, height: right.height)
                    .redacted(reason: scene.locked ? .privacy : [])
                    .scaleEffect(scale, anchor: .topLeading)
                    .offset(x: w / 2 + 20, y: 44)
            }
        }
        .modifier(Recolour(mode: scene.mode))
        .frame(width: w, height: h, alignment: .topLeading)
        .background(Color.void)
        // Counter-clockwise, so the Dynamic Island lands at the scene's right
        // edge, clear of both stacks.
        .rotationEffect(.degrees(-90))
        .frame(width: screen.width, height: screen.height)
    }
}

// MARK: - Imitated system rendering

/// iOS recolours a tinted or clear home screen and StandBy at night itself;
/// the host can only approximate it, by taking the colour out and laying the
/// tint back over.
private struct Recolour: ViewModifier {
    let mode: WidgetHostScene.Mode

    func body(content: Content) -> some View {
        switch mode {
        case .fullColor: content
        case .tinted: content.grayscale(1).brightness(0.08).colorMultiply(Color(red: 0.55, green: 0.93, blue: 0.62))
        case .clear: content.grayscale(1).brightness(0.18)
        case .night: content.grayscale(1).brightness(0.25).colorMultiply(Color(red: 1, green: 0.22, blue: 0.18))
        }
    }
}

/// The frame geometry per screen width: the 402 pt iPhone 17 and the 375 pt SE.
struct HostMetrics {
    let width: CGFloat
    var se: Bool { width < 390 }
    var margin: CGFloat { se ? 28 : 20 }
    var small: CGFloat { se ? 148 : 170 }
    var wide: CGFloat { width - 2 * margin }
    var largeHeight: CGFloat { se ? 324 : 382 }
    var radius: CGFloat { se ? 20 : 22 }
    var top: CGFloat { se ? 62 : 70 }
    var gap: CGFloat { se ? 22 : 24 }
    var mediumTop: CGFloat { top + small + gap }
    var icon: CGFloat { se ? 60 : 64 }
    var pitch: CGFloat { se ? 88 : 96 }

    /// The centre of column `col` (0…3) on a row whose icon top is `y`.
    func icon(col: Int, y: CGFloat) -> CGPoint {
        let first = margin + (se ? 2 : -1) + icon / 2
        let step = (width - 2 * (first)) / 3
        return CGPoint(x: first + CGFloat(col) * step, y: y + icon / 2 + 12)
    }
}

private struct Wallpaper: View {
    let mode: WidgetHostScene.Mode

    var body: some View {
        switch mode {
        case .tinted:
            LinearGradient(colors: [Color(red: 0.05, green: 0.13, blue: 0.08), Color(red: 0.02, green: 0.06, blue: 0.04)],
                           startPoint: .top, endPoint: .bottom)
        case .clear:
            // Overlays, so the glows never widen the screen they sit on.
            LinearGradient(colors: [Color(red: 0.35, green: 0.48, blue: 0.62), Color(red: 0.78, green: 0.6, blue: 0.48)],
                           startPoint: .top, endPoint: .bottom)
                .overlay {
                    Circle().fill(Color(red: 0.95, green: 0.78, blue: 0.6)).frame(width: 360).blur(radius: 70).offset(x: 40, y: -120)
                }
                .overlay {
                    Circle().fill(Color(red: 0.6, green: 0.75, blue: 0.85)).frame(width: 300).blur(radius: 80).offset(x: -120, y: 220)
                }
                .clipped()
        default:
            LinearGradient(colors: [Color(red: 0.14, green: 0.11, blue: 0.24), Color(red: 0.03, green: 0.05, blue: 0.09),
                                    Color(red: 0.03, green: 0.07, blue: 0.1)],
                           startPoint: .topLeading, endPoint: .bottom)
                .overlay {
                    Circle().fill(Color(red: 0.08, green: 0.3, blue: 0.38).opacity(0.7)).frame(width: 420).blur(radius: 90)
                        .offset(x: 110, y: 160)
                }
                .clipped()
        }
    }
}

enum HostApp: CaseIterable {
    case agenda, fotos, camera, verder, klok, notities, instellingen, mail, kaarten, weer, wallet, gezondheid
    case rekenmachine, podcasts, bestanden, herinneringen, telefoon, safari, berichten, muziek

    var name: String {
        switch self {
        case .agenda: "Agenda"
        case .fotos: "Foto's"
        case .camera: "Camera"
        case .verder: "verder"
        case .klok: "Klok"
        case .notities: "Notities"
        case .instellingen: "Instellingen"
        case .mail: "Mail"
        case .kaarten: "Kaarten"
        case .weer: "Weer"
        case .wallet: "Wallet"
        case .gezondheid: "Gezondheid"
        case .rekenmachine: "Rekenmachine"
        case .podcasts: "Podcasts"
        case .bestanden: "Bestanden"
        case .herinneringen: "Herinneringen"
        case .telefoon: "Telefoon"
        case .safari: "Safari"
        case .berichten: "Berichten"
        case .muziek: "Muziek"
        }
    }

    var symbol: String {
        switch self {
        case .agenda: "calendar"
        case .fotos: "camera.aperture"
        case .camera: "camera"
        case .verder: ""
        case .klok: "clock"
        case .notities: "doc.text"
        case .instellingen: "gearshape"
        case .mail: "envelope"
        case .kaarten: "map"
        case .weer: "cloud"
        case .wallet: "wallet.pass"
        case .gezondheid: "heart"
        case .rekenmachine: "plus.forwardslash.minus"
        case .podcasts: "mic"
        case .bestanden: "folder"
        case .herinneringen: "list.bullet"
        case .telefoon: "phone"
        case .safari: "safari"
        case .berichten: "message"
        case .muziek: "music.note"
        }
    }

    /// Full colour: the tile's two colours and the symbol's.
    var colours: (Color, Color, Color) {
        let white = (Color.white, Color(white: 0.92), Color.red)
        switch self {
        case .agenda: return white
        case .gezondheid: return (Color.white, Color(white: 0.92), Color(red: 0.95, green: 0.25, blue: 0.35))
        case .notities, .herinneringen: return (Color.white, Color(white: 0.92), Color(white: 0.3))
        case .fotos: return (Color(red: 0.98, green: 0.4, blue: 0.7), Color(red: 0.6, green: 0.35, blue: 0.95), .white)
        case .camera, .instellingen: return (Color(white: 0.55), Color(white: 0.3), .white)
        case .klok, .wallet, .rekenmachine: return (Color(white: 0.2), Color(white: 0.05), .white)
        case .mail, .weer, .safari, .bestanden: return (Color(red: 0.3, green: 0.65, blue: 1), Color(red: 0.1, green: 0.4, blue: 0.95), .white)
        case .kaarten, .telefoon, .berichten: return (Color(red: 0.4, green: 0.85, blue: 0.5), Color(red: 0.15, green: 0.65, blue: 0.3), .white)
        case .podcasts: return (Color(red: 0.75, green: 0.4, blue: 1), Color(red: 0.5, green: 0.2, blue: 0.85), .white)
        case .muziek: return (Color(red: 1, green: 0.4, blue: 0.45), Color(red: 0.95, green: 0.2, blue: 0.3), .white)
        case .verder: return (.black, .black, .white)
        }
    }
}

/// The real app icon, read from the built bundle (the one AppIcon set).
private let bundleIcon: UIImage? = {
    if let icons = Bundle.main.infoDictionary?["CFBundleIcons"] as? [String: Any],
       let primary = icons["CFBundlePrimaryIcon"] as? [String: Any],
       let files = primary["CFBundleIconFiles"] as? [String], let name = files.last,
       let image = UIImage(named: name) {
        return image
    }
    return UIImage(named: "AppIcon")
}()

private struct AppIcon: View {
    let app: HostApp
    let mode: WidgetHostScene.Mode
    let size: CGFloat
    var labelled = true

    var body: some View {
        VStack(spacing: 5) {
            tile
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
            if labelled {
                Text(app.name).font(.system(size: 12)).foregroundStyle(mode == .clear ? Color.white.opacity(0.85) : .white)
                    .lineLimit(1).fixedSize()
            }
        }
    }

    @ViewBuilder private var tile: some View {
        if app == .verder, let bundleIcon {
            Image(uiImage: bundleIcon).resizable()
        } else {
            let (a, b, fg) = app.colours
            ZStack {
                switch mode {
                case .tinted:
                    RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
                        .fill(Color(red: 0.06, green: 0.14, blue: 0.09))
                        .overlay(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
                            .strokeBorder(Color(red: 0.4, green: 0.8, blue: 0.5).opacity(0.25)))
                case .clear:
                    Rectangle().fill(.ultraThinMaterial).overlay(Color.white.opacity(0.12))
                default:
                    LinearGradient(colors: [a, b], startPoint: .top, endPoint: .bottom)
                }
                Image(systemName: app.symbol)
                    .font(.system(size: size * 0.42, weight: .regular))
                    .foregroundStyle(mode == .tinted ? Color(red: 0.55, green: 0.93, blue: 0.62)
                                     : mode == .clear ? Color.white.opacity(0.9) : fg)
            }
        }
    }
}

private struct Dock: View {
    let m: HostMetrics
    let mode: WidgetHostScene.Mode

    var body: some View {
        let height: CGFloat = m.se ? 82 : 84
        let bottom: CGFloat = m.se ? 5 : 8
        GeometryReader { geo in
            ZStack {
                HStack(spacing: 3) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle().fill(Color.white.opacity(i == 0 ? 0.9 : 0.35)).frame(width: 7, height: 7)
                    }
                }
                .position(x: geo.size.width / 2, y: geo.size.height - bottom - height - 14)
                RoundedRectangle(cornerRadius: 34, style: .continuous)
                    .fill(mode == .clear ? Color.white.opacity(0.2) : Color.white.opacity(0.1))
                    .frame(width: geo.size.width - 24, height: height)
                    .position(x: geo.size.width / 2, y: geo.size.height - bottom - height / 2)
                ForEach(Array([HostApp.telefoon, .safari, .berichten, .muziek].enumerated()), id: \.offset) { i, app in
                    let step = (geo.size.width - 24 - 4 * m.icon) / 5
                    AppIcon(app: app, mode: mode, size: m.icon, labelled: false)
                        .position(x: 12 + step * CGFloat(i + 1) + m.icon * (CGFloat(i) + 0.5),
                                  y: geo.size.height - bottom - height / 2)
                }
            }
        }
    }
}
#endif
