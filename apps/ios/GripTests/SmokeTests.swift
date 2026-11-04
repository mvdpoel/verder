import Testing
import Foundation
@testable import Grip

@Test func bundleIdentifier() {
    let id = Bundle.main.bundleIdentifier ?? ""
    #expect(id.hasPrefix("pro.vanderpoel.grip"))
}
