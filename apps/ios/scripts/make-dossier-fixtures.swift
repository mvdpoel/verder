// Generates the pocket dossier's synthetic fixture (fixture `dossier`, see
// docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md):
//
//   Grip/FixtureData/_shared/documents/<id>/file.pdf   one tiny one-page PDF per document
//   Grip/FixtureData/_shared/documents/sync.json       the delta, with each PDF's OWN sha256 and size
//   Grip/FixtureData/_shared/documents/texts.json      the extracted text of every document that has one
//
// This file is the ONE source of all three, so they cannot drift: the phone
// checks every download against the delta's sha256 (the vault is
// content-addressed), and `FixtureTests` checks the bundled files the same way.
//
// The PDFs are written by hand (PDF 1.4, Helvetica, ASCII only), not through
// CGPDFContext, which stamps a creation date: regenerating gives the SAME
// bytes, so the hashes in sync.json only change when the content does.
// Everything in them is invented — the synthetic case and nothing else.
//
// Run from the repo root:
//
//   swiftc -O apps/ios/scripts/make-dossier-fixtures.swift -o /tmp/make-dossier-fixtures \
//     && /tmp/make-dossier-fixtures apps/ios/Grip/FixtureData/_shared
//
// Kept out of every Xcode target: scripts/ is not a source path in project.yml.

import CryptoKit
import Foundation

struct Doc {
    let id: String
    let title: String
    let docType: String?
    let status: String
    let receivedAt: String
    /// nil = no extracted text (`hasText: false`), like a scanned ID card.
    let text: String?
    /// The ingest path, when it matters to the reader ("foto-scan"). Not
    /// served by dossier-sync.ts yet: the phone reads it as optional.
    var source: String? = nil
    /// How the PDF is drawn: one page with the title and the text, unless
    /// the frames show this document's own pages.
    var layout: Layout = .plain(pages: 1)
}

enum Layout {
    case plain(pages: Int)
    /// The "Document / viewer" frame's letter, two pages.
    case letter
    /// A photographed ID card: a card shape, no text layer.
    case card
}

// Dates, soorten and statuses follow the "dossier · final" frames (2026-11-03).
// Nothing here is the real case: no date is the aanmelding, the stukken to the
// rechtbank or the beschikking (FixtureTests.fixturesHoldNoRealCaseDate).
let docs: [Doc] = [
    Doc(id: "00000000-f1c5-4000-8000-200000000300", title: "Beschikking Rechtbank Westerlaan", docType: "letter",
        status: "filed", receivedAt: "2026-08-14T09:00:00.000Z",
        text: "Rechtbank Westerlaan. Beschikking van 3 juni 2026. De rechtbank stelt de goederen onder bewind en benoemt Bewindkantoor Noordkust tot bewindvoerder.",
        layout: .plain(pages: 3)),
    Doc(id: "00000000-f1c5-4000-8000-200000000105", title: "Loonstrook 2026-09", docType: "payslip",
        status: "filed", receivedAt: "2026-09-26T09:00:00.000Z",
        text: "Atelier Sterrenwacht. Loonstrook september 2026. Netto uit te betalen 2.400,00."),
    Doc(id: "00000000-f1c5-4000-8000-200000000104", title: "Loonstrook 2026-10", docType: "payslip",
        status: "filed", receivedAt: "2026-10-28T09:00:00.000Z",
        text: "Atelier Sterrenwacht. Loonstrook oktober 2026. Netto uit te betalen 2.400,00."),
    Doc(id: "00000000-f1c5-4000-8000-200000000303", title: "Polis Duinzorg 2026", docType: "contract",
        status: "filed", receivedAt: "2026-09-04T09:00:00.000Z",
        text: "Zorgverzekeraar Duinzorg. Polisblad 2026. Basisverzekering met het verplichte eigen risico."),
    Doc(id: "00000000-f1c5-4000-8000-200000000304", title: "Huurcontract Lindehof", docType: "contract",
        status: "filed", receivedAt: "2025-03-01T09:00:00.000Z",
        text: "Woonstichting Lindehof. Huurovereenkomst zelfstandige woonruimte, ingangsdatum 1 maart 2025."),
    Doc(id: "00000000-f1c5-4000-8000-200000000106", title: "Sommatie Kade & Partners 14 okt", docType: "letter",
        status: "filed", receivedAt: "2026-10-14T09:00:00.000Z",
        text: "Incassobureau Kade & Partners. Sommatie namens Stroomnet Energie. Betaal binnen veertien dagen om verdere kosten te voorkomen."),
    Doc(id: "00000000-f1c5-4000-8000-200000000306", title: "Afschrift september", docType: "bank-statement",
        status: "filed", receivedAt: "2026-10-02T09:00:00.000Z",
        text: "Rekeningafschrift september 2026. Rekening NL00TEST0123456789, beheerrekening."),
    Doc(id: "00000000-f1c5-4000-8000-200000000307", title: "Brief Gemeente Westerlaan 30 okt", docType: "letter",
        status: "filed", receivedAt: "2026-10-30T09:00:00.000Z",
        text: "Gemeente Westerlaan. We hebben je brief ontvangen en nemen binnen acht weken een besluit.",
        layout: .letter),
    Doc(id: "00000000-f1c5-4000-8000-200000000308", title: "ID-kaart", docType: "id-document",
        status: "filed", receivedAt: "2026-09-12T09:00:00.000Z", text: nil, source: "phone-scan",
        layout: .card),
    Doc(id: "00000000-f1c5-4000-8000-200000000309", title: "Jaaropgaaf 2025", docType: "other",
        status: "filed", receivedAt: "2026-02-20T09:00:00.000Z",
        text: "Atelier Sterrenwacht. Jaaropgaaf 2025. Fiscaal loon over het hele jaar."),
    Doc(id: "00000000-f1c5-4000-8000-200000000310", title: "Bevestiging aanmelding Noordkust", docType: "letter",
        status: "filed", receivedAt: "2026-09-18T09:00:00.000Z",
        text: "Bewindkantoor Noordkust bevestigt je aanmelding. Team Startdossier helpt bij de aanvraag voor bijzondere bijstand bij de gemeente."),
    Doc(id: "00000000-f1c5-4000-8000-200000000311", title: "Formulier bijzondere bijstand", docType: "other",
        status: "inbox", receivedAt: "2026-10-29T09:00:00.000Z",
        text: "Aanvraag bijzondere bijstand voor de periode vanaf 1 oktober 2026. Vul alle velden in en onderteken het formulier. Gemeente Westerlaan."),
]

/// A PDF string literal: `\`, `(` and `)` escaped. ASCII only, enforced.
func pdfString(_ s: String) -> String {
    precondition(s.allSatisfy(\.isASCII), "fixture PDF text must be ASCII: \(s)")
    return "(" + s.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "(", with: "\\(")
        .replacingOccurrences(of: ")", with: "\\)") + ")"
}

/// Greedy word wrap at `width` characters.
func wrap(_ text: String, width: Int) -> [String] {
    var lines: [String] = []
    var line = ""
    for word in text.split(separator: " ") {
        if !line.isEmpty, line.count + 1 + word.count > width { lines.append(line); line = "" }
        line += (line.isEmpty ? "" : " ") + word
    }
    if !line.isEmpty { lines.append(line) }
    return lines
}

/// Text lines from `y` down: (font, size, text, extra gap before).
func lines(_ rows: [(String, Int, String, Int)], from top: Int) -> String {
    var y = top
    var out = ""
    for (font, size, text, gap) in rows {
        y -= gap
        out += "BT /\(font) \(size) Tf 56 \(y) Td \(pdfString(text)) Tj ET\n"
        y -= size + 4
    }
    return out
}

let footer = "BT /F1 9 Tf 56 60 Td \(pdfString("Synthetisch voorbeeld - geen echt document.")) Tj ET\n"

func streams(for doc: Doc) -> [String] {
    switch doc.layout {
    case .plain(let count):
        var first = "BT /F1 18 Tf 56 770 Td \(pdfString(doc.title)) Tj ET\n"
        let body = wrap(doc.text ?? "", width: 80)
        if !body.isEmpty {
            first += "BT /F1 11 Tf 56 736 Td 15 TL\n"
            first += body.map { "\(pdfString($0)) Tj T*" }.joined(separator: "\n") + "\nET\n"
        }
        return (1...count).map { n in
            let page = "BT /F1 9 Tf 480 800 Td \(pdfString("Pagina \(n) van \(count)")) Tj ET\n"
            return (n == 1 ? first : "BT /F1 14 Tf 56 770 Td \(pdfString(doc.title)) Tj ET\n") + (count > 1 ? page : "") + footer
        }
    case .letter:
        let para = { (s: String) in wrap(s, width: 72).enumerated().map { ("F1", 13, $1, $0 == 0 ? 13 : 0) } }
        let one: [(String, Int, String, Int)] = [("F2", 19, "Gemeente Westerlaan", 0),
             ("F1", 10, "Afdeling Werk en Inkomen - Postbus 100 - 9999 ZZ Westerlaan", 8),
             ("F3", 11, "Westerlaan, 30 oktober 2026", 18),
             ("F3", 11, "Ons kenmerk  WL-TEST-0412", 0),
             ("F2", 13, "Betreft: uw aanvraag bijzondere bijstand", 18),
             ("F1", 13, "Geachte heer, mevrouw,", 13)]
            + para("Wij hebben uw aanvraag voor bijzondere bijstand ontvangen op 27 oktober 2026. Om uw aanvraag te kunnen beoordelen, hebben wij nog enkele stukken van u nodig.")
            + para("Wilt u het ondertekende aanvraagformulier en uw loonstroken van september en oktober voor 13 november 2026 aan ons sturen? Dat kan via uw bewindvoerder of per post.")
            + para("Heeft u vragen? Bel ons op werkdagen tussen 9.00 en 12.00 uur.")
            + [("F1", 13, "Met vriendelijke groet,", 13), ("F1", 13, "Team Bijzondere Bijstand", 0)]
        let two: [(String, Int, String, Int)] = [("F2", 15, "Bijlage - welke stukken wij nodig hebben", 0),
             ("F1", 13, "1. Het ondertekende aanvraagformulier bijzondere bijstand.", 14),
             ("F1", 13, "2. Uw loonstroken van september en oktober 2026.", 4),
             ("F1", 13, "Stuur de stukken voor 13 november 2026.", 14)]
        return [lines(one, from: 780) + footer, lines(two, from: 780) + footer]
    case .card:
        // A light page with a card: the card, a photo square and three bars.
        let card = """
        0.74 0.80 0.86 rg 110 470 375 230 re f
        0.70 0.78 0.88 rg 135 520 100 130 re f
        0.68 0.74 0.80 rg 260 630 180 14 re f 260 600 140 12 re f 260 575 160 12 re f

        """
        return [card]
    }
}

func pdf(for doc: Doc) -> Data {
    let pages = streams(for: doc)
    let fonts = "<< /F1 4 0 R /F2 5 0 R /F3 6 0 R >>"
    var objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [\((0..<pages.count).map { "\(7 + 2 * $0) 0 R" }.joined(separator: " "))] /Count \(pages.count) >>",
        "",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    ]
    objects[2] = "<< /Producer (Grip fixtures) >>"
    for (i, stream) in pages.enumerated() {
        objects.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font \(fonts) >> /Contents \(8 + 2 * i) 0 R >>")
        objects.append("<< /Length \(stream.utf8.count) >>\nstream\n\(stream)endstream")
    }
    var out = "%PDF-1.4\n"
    var offsets: [Int] = []
    for (i, body) in objects.enumerated() {
        offsets.append(out.utf8.count)
        out += "\(i + 1) 0 obj\n\(body)\nendobj\n"
    }
    let xref = out.utf8.count
    out += "xref\n0 \(objects.count + 1)\n0000000000 65535 f \n"
    for o in offsets { out += String(format: "%010d 00000 n \n", o) }
    out += "trailer\n<< /Size \(objects.count + 1) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n"
    return Data(out.utf8)
}

func json(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes])
    let array = String(decoding: data, as: UTF8.self)
    return String(array.dropFirst().dropLast())
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: make-dossier-fixtures <FixtureData/_shared>\n".utf8))
    exit(2)
}
let shared = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let documents = shared.appending(path: "documents", directoryHint: .isDirectory)

struct Built { let doc: Doc; let bytes: Data; let sha: String }
var built: [Built] = []
for doc in docs {
    let bytes = pdf(for: doc)
    let dir = documents.appending(path: doc.id, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try bytes.write(to: dir.appending(path: "file.pdf"))
    built.append(Built(doc: doc, bytes: bytes, sha: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()))
}

/// One delta, as `dossierSync.delta` serves it. `sizes` overrides a
/// document's `sizeBytes` (a capture's "4,1 van 9,8 MB"; the bytes served
/// stay the tiny PDF, whose sha the phone checks); `total`/`totalBytes` are
/// the whole dossier, which the first-sync card needs and dossier-sync.ts
/// does not serve yet (the phone reads them as optional).
func delta(_ items: [Built], cursor: Int, sizes: [String: Int] = [:], total: (Int, Int)? = nil) -> String {
    let upserts = items.map { b in
        """
            {
              "id": \(json(b.doc.id)),
              "title": \(json(b.doc.title)),
              "docType": \(b.doc.docType.map(json) ?? "null"),
              "status": \(json(b.doc.status)),
              "receivedAt": \(json(b.doc.receivedAt)),
              "mime": "application/pdf",
              "sizeBytes": \(sizes[b.doc.id] ?? b.bytes.count),
              "sha256": \(json(b.sha)),
              "hasText": \(b.doc.text != nil)\(b.doc.source.map { ",\n          \"source\": \(json($0))" } ?? "")
            }
        """
    }
    let totals = total.map { "  \"total\": \($0.0),\n  \"totalBytes\": \($0.1),\n" } ?? ""
    return """
    {
      "cursor": \(cursor),
      "more": false,
    \(totals)  "upserts": [
    \(upserts.joined(separator: ",\n"))
      ],
      "tombstones": []
    }

    """
}
try Data(delta(built, cursor: 412).utf8).write(to: documents.appending(path: "sync.json"))

// The capture variants (docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md,
// "Dossier states"), each in its own fixture folder next to `_shared`.
func variant(_ name: String, _ file: String, _ body: String) throws {
    let dir = shared.deletingLastPathComponent().appending(path: name).appending(path: "documents", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try Data(body.utf8).write(to: dir.appending(path: file))
}
func id(_ title: String) -> String { built.first { $0.doc.title == title }!.doc.id }
let newestFirst = built.sorted { $0.doc.receivedAt > $1.doc.receivedAt }
// First sync: 12 documents, 9,8 MB. The server lists them in ITS order, not
// by date, so files arrive out of date order: the two newest, then three
// older ones (4,1 MB in all); the sixth — Loonstrook 2026-10 — never answers
// (`neverPaths`) or has no network (`offlinePaths`). The list keeps a
// skeleton in each place still on its way (frame "Dossier / eerste sync":
// two rows, then skeletons).
let mb = [1_200_000, 900_000, 400_000, 800_000, 800_000, 600_000, 900_000, 1_100_000, 500_000, 700_000, 1_200_000, 700_000]
let sizes = Dictionary(uniqueKeysWithValues: zip(newestFirst.map(\.doc.id), mb))
let arrivalFirst = ["Brief Gemeente Westerlaan 30 okt", "Formulier bijzondere bijstand", "Beschikking Rechtbank Westerlaan",
                    "Huurcontract Lindehof", "Loonstrook 2026-09", "Loonstrook 2026-10"]
let arrival = arrivalFirst.map { t in built.first { $0.doc.title == t }! }
    + newestFirst.filter { !arrivalFirst.contains($0.doc.title) }
for name in ["dossier-eerste-sync", "dossier-onderbroken"] {
    try variant(name, "sync.json", delta(arrival, cursor: 412, sizes: sizes, total: (12, mb.reduce(0, +))))
}
// Bijwerken: the phone took nine; the next delta brings three new ones.
let later = ["Loonstrook 2026-10", "Brief Gemeente Westerlaan 30 okt", "Formulier bijzondere bijstand"]
try variant("dossier-bijwerken", "sync.json", delta(built.filter { !later.contains($0.doc.title) }, cursor: 412))
// The later delta says the whole dossier (12), so the Documenten label
// counts 12 while the third is still on its way.
let built12 = built.reduce(0) { $0 + $1.bytes.count }
try variant("dossier-bijwerken", "sync~cursor=412&limit=50.json",
            delta(later.map { t in built.first { $0.doc.title == t }! }, cursor: 418, total: (12, built12)))
// Nog niet op deze iPhone: Loonstrook 2026-10 is 0,4 MB and its file answers 503.
for name in ["dossier-niet-binnen", "dossier-niet-binnen-offline"] {
    try variant(name, "sync.json", delta(built, cursor: 412, sizes: [id("Loonstrook 2026-10"): 420_000]))
}

let texts = docs.compactMap { doc in
    doc.text.map { """
      {
        "id": \(json(doc.id)),
        "text": \(json($0)),
        "truncated": false
      }
    """ }
}
try Data("[\n\(texts.joined(separator: ",\n"))\n]\n".utf8).write(to: documents.appending(path: "texts.json"))
print("make-dossier-fixtures: \(docs.count) PDFs, \(texts.count) texts")
