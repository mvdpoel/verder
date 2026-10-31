import Testing
import Foundation
import UIKit
import Vision
@testable import Verder

struct PageCleanerTests {
    @Test func everyVariantKeepsThePageSize() throws {
        for variant in PageCleaner.Variant.allCases {
            let out = PageCleaner.clean(Fixture.letterPage, variant: variant)
            let cg = try #require(out.cgImage, "\(variant) produced no bitmap")
            #expect(cg.width == 3024 && cg.height == 4032, "\(variant)")
        }
    }

    @Test func rawIsUntouched() {
        let image = Fixture.letterPage
        #expect(PageCleaner.clean(image, variant: .raw) === image)
    }

    @Test func defaultIsBaseline() {
        #expect(PageCleaner.Variant.default == .baseline)
    }

    /// The measurement switch: a launch argument `-pageCleaner documentEnhancer`
    /// (which lands in UserDefaults' argument domain) picks the variant, so the
    /// main session can shoot the same letters raw / baseline / enhanced
    /// without a rebuild. Anything unknown falls back to the default.
    @Test func variantIsReadFromDefaults() throws {
        let defaults = try #require(UserDefaults(suiteName: "PageCleanerTests"))
        defaults.removePersistentDomain(forName: "PageCleanerTests")
        #expect(PageCleaner.Variant.current(defaults) == .baseline)
        defaults.set("documentEnhancer", forKey: PageCleaner.Variant.defaultsKey)
        #expect(PageCleaner.Variant.current(defaults) == .documentEnhancer)
        defaults.set("dewarp", forKey: PageCleaner.Variant.defaultsKey)
        #expect(PageCleaner.Variant.current(defaults) == .baseline)
    }

    /// Spec §7.1: unreadable output is worse than wrinkled output. Cleanup must
    /// never cost text: on-device OCR of every variant reads at least 95% of
    /// the characters it reads on the raw page.
    @Test func cleanupNeverCostsText() async throws {
        let raw = try await Self.ocrCharacterCount(Fixture.letterPage)
        print("on-device OCR characters, raw: \(raw)")
        #expect(raw > 1000, "the fixture should read as a letter")
        for variant in PageCleaner.Variant.allCases where variant != .raw {
            let n = try await Self.ocrCharacterCount(PageCleaner.clean(Fixture.letterPage, variant: variant))
            print("on-device OCR characters, \(variant): \(n)")
            #expect(Double(n) >= Double(raw) * 0.95, "\(variant) read \(n) of \(raw)")
        }
    }

    static func ocrCharacterCount(_ image: UIImage) async throws -> Int {
        let request = RecognizeTextRequest()
        let observations = try await request.perform(on: try #require(image.cgImage))
        return observations.compactMap { $0.topCandidates(1).first?.string.count }.reduce(0, +)
    }
}
