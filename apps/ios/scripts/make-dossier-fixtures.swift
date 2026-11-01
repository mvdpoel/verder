// Generates the pocket dossier's synthetic fixture (fixture `dossier`, see
// docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md):
//
//   Verder/FixtureData/_shared/documents/<id>/file.pdf   one tiny one-page PDF per document
//   Verder/FixtureData/_shared/documents/sync.json       the delta, with each PDF's OWN sha256 and size
//   Verder/FixtureData/_shared/documents/texts.json      the extracted text of every document that has one
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
//     && /tmp/make-dossier-fixtures apps/ios/Verder/FixtureData/_shared
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
}

let docs: [Doc] = [
    Doc(id: "00000000-f1c5-4000-8000-200000000300", title: "Beschikking Rechtbank Westerlaan", docType: "letter",
        status: "filed", receivedAt: "2026-06-03T09:00:00.000Z",
        text: "Rechtbank Westerlaan. Beschikking van 3 juni 2026. De rechtbank stelt de goederen onder bewind en benoemt Bewindkantoor Noordkust tot bewindvoerder."),
    Doc(id: "00000000-f1c5-4000-8000-200000000105", title: "Loonstrook 2026-09", docType: "payslip",
        status: "filed", receivedAt: "2026-09-25T09:00:00.000Z",
        text: "Atelier Sterrenwacht. Loonstrook september 2026. Netto uit te betalen 2.400,00."),
    Doc(id: "00000000-f1c5-4000-8000-200000000104", title: "Loonstrook 2026-10", docType: "payslip",
        status: "filed", receivedAt: "2026-10-26T09:00:00.000Z",
        text: "Atelier Sterrenwacht. Loonstrook oktober 2026. Netto uit te betalen 2.400,00."),
    Doc(id: "00000000-f1c5-4000-8000-200000000303", title: "Polis Duinzorg 2026", docType: "contract",
        status: "filed", receivedAt: "2026-01-05T09:00:00.000Z",
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
        status: "inbox", receivedAt: "2026-10-30T09:00:00.000Z",
        text: "Gemeente Westerlaan. We hebben je brief ontvangen en nemen binnen acht weken een besluit."),
    Doc(id: "00000000-f1c5-4000-8000-200000000308", title: "ID-kaart", docType: "id-document",
        status: "filed", receivedAt: "2026-05-11T09:00:00.000Z", text: nil),
    Doc(id: "00000000-f1c5-4000-8000-200000000309", title: "Jaaropgaaf 2025", docType: nil,
        status: "filed", receivedAt: "2026-02-20T09:00:00.000Z",
        text: "Atelier Sterrenwacht. Jaaropgaaf 2025. Fiscaal loon over het hele jaar."),
    Doc(id: "00000000-f1c5-4000-8000-200000000310", title: "Bevestiging aanmelding Noordkust", docType: nil,
        status: "filed", receivedAt: "2026-05-11T09:00:00.000Z",
        text: "Bewindkantoor Noordkust bevestigt je aanmelding. Team Startdossier helpt ook met de aanvraag bijzondere bijstand."),
    Doc(id: "00000000-f1c5-4000-8000-200000000311", title: "Formulier bijzondere bijstand", docType: nil,
        status: "inbox", receivedAt: "2026-10-29T09:00:00.000Z",
        text: "Aanvraagformulier bijzondere bijstand Gemeente Westerlaan. Handtekening aanvrager."),
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

func pdf(for doc: Doc) -> Data {
    var stream = "BT /F1 18 Tf 56 770 Td \(pdfString(doc.title)) Tj ET\n"
    let body = wrap(doc.text ?? "", width: 80)
    if !body.isEmpty {
        stream += "BT /F1 11 Tf 56 736 Td 15 TL\n"
        stream += body.map { "\(pdfString($0)) Tj T*" }.joined(separator: "\n") + "\nET\n"
    }
    stream += "BT /F1 9 Tf 56 60 Td \(pdfString("Synthetisch voorbeeld - geen echt document.")) Tj ET\n"

    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        "<< /Length \(stream.utf8.count) >>\nstream\n\(stream)endstream",
    ]
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

var upserts: [String] = []
for doc in docs {
    let bytes = pdf(for: doc)
    let dir = documents.appending(path: doc.id, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try bytes.write(to: dir.appending(path: "file.pdf"))
    let sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    upserts.append("""
        {
          "id": \(json(doc.id)),
          "title": \(json(doc.title)),
          "docType": \(doc.docType.map(json) ?? "null"),
          "status": \(json(doc.status)),
          "receivedAt": \(json(doc.receivedAt)),
          "mime": "application/pdf",
          "sizeBytes": \(bytes.count),
          "sha256": \(json(sha)),
          "hasText": \(doc.text != nil)
        }
    """)
}
let sync = """
{
  "cursor": 412,
  "more": false,
  "upserts": [
\(upserts.joined(separator: ",\n"))
  ],
  "tombstones": []
}

"""
try Data(sync.utf8).write(to: documents.appending(path: "sync.json"))

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
