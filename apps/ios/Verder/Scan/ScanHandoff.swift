import SwiftUI

/// The page flying from the camera into the queue (CapWords, brief §2.6),
/// shared between Scan and whoever draws it.
///
/// Drawn ABOVE the TabView by RootView, not inside Scan (frame "Scan ·
/// overdracht"): the whole screen dims, the tab bar included, while the
/// accessory the page lands on stays lit. A layer inside the tab's content
/// sits under the system tab bar and over Scan's own accessory, which is
/// exactly backwards. Scan draws it itself only when nothing above it does
/// (the sign-in screen's full-screen Scan has no tab bar).
@MainActor @Observable
final class ScanHandoff {
    struct Flight: Equatable {
        let id = UUID()
        let image: UIImage?
        var progress: CGFloat = 0
    }

    var flight: Flight?
    /// The accessory's frame in global coordinates: where the page lands and
    /// the hole left in the dim.
    var accessoryFrame: CGRect = .zero

    /// The dim's strength along the flight: full at the start, gone as the
    /// page lands, so the screen comes back with it.
    nonisolated static func dimOpacity(progress p: CGFloat) -> Double {
        let q = p * p
        return Double(0.55 * (1 - p * q))
    }

    /// The accessory's corner radius (`QueueAccessoryView`), for the hole.
    static let accessoryCornerRadius: CGFloat = 24
}

/// The flight itself: the dim with the accessory cut out, and the page.
struct ScanHandoffOverlay: View {
    let handoff: ScanHandoff
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let flight = handoff.flight {
            GeometryReader { geo in
                let origin = geo.frame(in: .global).origin
                let accessory = handoff.accessoryFrame.offsetBy(dx: -origin.x, dy: -origin.y)
                let start = CGPoint(x: geo.size.width / 2, y: geo.size.height * 0.45)
                let end = handoff.accessoryFrame == .zero
                    ? CGPoint(x: geo.size.width / 2, y: geo.size.height)
                    : CGPoint(x: accessory.minX + 30, y: accessory.midY)
                let p = flight.progress
                // Down first, then in: y follows p, x and the shrink follow
                // later, so the page reads as dropping into the queue.
                let q = p * p
                ZStack {
                    DimWithHole(hole: handoff.accessoryFrame == .zero ? nil : accessory,
                                cornerRadius: ScanHandoff.accessoryCornerRadius)
                        .fill(Color.black.opacity(ScanHandoff.dimOpacity(progress: p)), style: FillStyle(eoFill: true))
                    if reduceMotion {
                        PageThumb(image: flight.image)
                            .frame(width: 120, height: 152)
                            .position(start)
                            .opacity(1 - p)
                    } else {
                        PageThumb(image: flight.image)
                            .frame(width: 120, height: 152)
                            .scaleEffect(1 - 0.8 * p * q)
                            .rotationEffect(.degrees(8 * (1 - q)))
                            .position(x: start.x + (end.x - start.x) * q, y: start.y + (end.y - start.y) * p)
                            .opacity(p > 0.9 ? Double((1 - p) * 10) : 1)
                    }
                }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    /// The whole rect, minus the accessory (even-odd fill).
    private struct DimWithHole: Shape {
        let hole: CGRect?
        let cornerRadius: CGFloat

        func path(in rect: CGRect) -> Path {
            var path = Path(rect)
            if let hole {
                path.addRoundedRect(in: hole, cornerSize: CGSize(width: cornerRadius, height: cornerRadius),
                                    style: .continuous)
            }
            return path
        }
    }
}
