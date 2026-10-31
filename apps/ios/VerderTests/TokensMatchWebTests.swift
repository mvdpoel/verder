import Testing
import Foundation
import UIKit
@testable import Verder

/// The drift guard. The web's `globals.css` `@theme` is the ONE definition of
/// the Holodek palette; `Tokens.swift` is a copy of it, and a copy is how a
/// palette starts drifting. These tests read the CSS file straight off disk
/// (the simulator test host can read the host filesystem) and fail the moment
/// the two disagree in either direction.
struct TokensMatchWebTests {
    /// `apps/web/src/app/globals.css`, located relative to this source file.
    static let globalsCSS: String = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()          // VerderTests/
            .appendingPathComponent("../../web/src/app/globals.css")
            .standardizedFileURL
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }()

    static func captures(_ pattern: String) throws -> [(String, String)] {
        let regex = try Regex(pattern)
        return globalsCSS.matches(of: regex).map { match in
            (String(match.output[1].substring ?? ""), String(match.output[2].substring ?? ""))
        }
    }

    @Test func globalsCSSIsReadable() {
        #expect(!Self.globalsCSS.isEmpty, "could not read apps/web/src/app/globals.css")
    }

    @Test func everyWebColorExistsWithTheSameHex() throws {
        let pairs = try Self.captures(#"--color-([a-z-]+):\s*(#[0-9a-f]{6,8})\b"#)
        let parsed = Dictionary(pairs, uniquingKeysWith: { first, _ in first })

        // The regex captures HEX values only. Every `--color-x:` DEFINITION must
        // therefore be one of them: a token written as rgba(), a var() alias or
        // upper-case hex would otherwise be skipped silently and never ported.
        // (`var(--color-x)` USES carry no colon and are not definitions.)
        let definitions = Self.globalsCSS.matches(of: try Regex(#"--color-[a-z-]+:"#)).count
        #expect(definitions == pairs.count, "a --color-* definition is not plain lower-case hex")
        #expect(pairs.count == parsed.count, "a --color-* token is defined twice")

        #expect(parsed.count == 27)
        #expect(parsed == Tokens.hex)
    }

    @Test func attnIsE8A557() {
        #expect(Tokens.hex["attn"] == "#e8a557")
    }

    @Test func everyHexHasAColor() {
        #expect(Set(Tokens.colors.keys) == Set(Tokens.hex.keys))
    }

    @Test func eightDigitHexCarriesAlpha() throws {
        let rgba = try #require(Tokens.rgba("#78b4e613"))
        #expect(abs(rgba.red - 0x78 / 255.0) < 1e-9)
        #expect(abs(rgba.green - 0xb4 / 255.0) < 1e-9)
        #expect(abs(rgba.blue - 0xe6 / 255.0) < 1e-9)
        #expect(abs(rgba.opacity - 0x13 / 255.0) < 1e-9)
        #expect(try #require(Tokens.rgba("#04070d")).opacity == 1)
        #expect(Tokens.rgba("#04070") == nil)
        #expect(Tokens.rgba("04070d") == nil)
    }

    @Test func radiiMatchWeb() throws {
        let parsed = Dictionary(
            try Self.captures(#"--radius-([a-z-]+):\s*([0-9.]+)px"#),
            uniquingKeysWith: { first, _ in first }
        )
        #expect(parsed == ["chip": "2", "panel": "3"])
        #expect(Radius.chip == 2)
        #expect(Radius.panel == 3)
    }

    /// The glows' colours are part of the palette too, so they are guarded the
    /// same way. Geometry is not: CSS spread has no SwiftUI equivalent (see `Glow`).
    @Test func glowColorsMatchWeb() throws {
        let parsed = Dictionary(
            try Self.captures(#"--shadow-([a-z-]+):[^;]*?(#[0-9a-f]{6,8})\s*;"#),
            uniquingKeysWith: { first, _ in first }
        )
        #expect(parsed.count == 5)
        #expect(parsed == Glow.hex)
    }

    @Test func bundledFontsAreRegistered() {
        #expect(UIFont(name: "IBMPlexMono-Regular", size: 12) != nil)
        #expect(UIFont(name: "IBMPlexMono-Medium", size: 12) != nil)
        #expect(UIFont(name: "IBMPlexMono-SemiBold", size: 12) != nil)
        #expect(UIFont.fontNames(forFamilyName: "Saira").isEmpty == false)
        #expect(UIFont.fontNames(forFamilyName: "IBM Plex Mono").isEmpty == false)
        #expect(UIFont.fontNames(forFamilyName: FontFamily.display).isEmpty == false)
        #expect(UIFont.fontNames(forFamilyName: FontFamily.mono).isEmpty == false)
    }

    @Test func infoPlistListsEveryBundledFont() throws {
        let listed = try #require(Bundle.main.object(forInfoDictionaryKey: "UIAppFonts") as? [String])
        #expect(listed == FontFamily.files)
        for file in listed {
            #expect(Bundle.main.url(forResource: file, withExtension: nil) != nil, "\(file) not in the app bundle")
        }
        // The OFL requires the licence to travel with the font.
        #expect(Bundle.main.url(forResource: "Saira-OFL", withExtension: "txt") != nil)
        #expect(Bundle.main.url(forResource: "IBMPlexMono-OFL", withExtension: "txt") != nil)
    }
}
