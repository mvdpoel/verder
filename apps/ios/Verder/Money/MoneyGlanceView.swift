import SwiftUI

/// Diagonal stripes: the hatched "not wholly covered by statements" state,
/// as /money draws it. Always paired with a word ("deels", "t/m …").
struct Hatch: Shape {
    var spacing: CGFloat = 6

    func path(in rect: CGRect) -> Path {
        var p = Path()
        var x = rect.minX - rect.height
        while x < rect.maxX {
            p.move(to: CGPoint(x: x, y: rect.maxY))
            p.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
            x += spacing
        }
        return p
    }
}
