import Testing
import Foundation
@testable import Verder

@Test func bundleIdentifier() {
    let id = Bundle.main.bundleIdentifier ?? ""
    #expect(id.hasPrefix("pro.vanderpoel.verder"))
}
