import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildZip, crc32, zipEntryName, ZIP_MAX_ENTRIES } from "./zip";

const AT = new Date("2026-08-30T10:00:00Z");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("crc32", () => {
  // The known-answer test for the polynomial. Get this wrong and every archive
  // opens with "CRC failed" in one tool and silently in another.
  it("matches the known value for 'The quick brown fox jumps over the lazy dog'", () => {
    expect(crc32(bytes("The quick brown fox jumps over the lazy dog")) >>> 0)
      .toBe(0x414fa339);
  });
  it("is 0 for empty input", () => {
    expect(crc32(new Uint8Array()) >>> 0).toBe(0);
  });
});

describe("buildZip", () => {
  it("writes an archive the system unzip accepts", () => {
    const zip = buildZip([
      { name: "inhoudsopgave.txt", bytes: bytes("een\ntwee\n"), at: AT },
      { name: "Beschikking.pdf", bytes: bytes("%PDF-1.4 fake"), at: AT },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "verder-zip-"));
    const path = join(dir, "t.zip");
    writeFileSync(path, zip);
    expect(() => execFileSync("unzip", ["-t", path])).not.toThrow();
    const listing = execFileSync("unzip", ["-Z1", path]).toString();
    expect(listing.split("\n").filter(Boolean))
      .toEqual(["inhoudsopgave.txt", "Beschikking.pdf"]);
  });

  it("round-trips the bytes", () => {
    const zip = buildZip([{ name: "a.txt", bytes: bytes("hallo"), at: AT }]);
    const dir = mkdtempSync(join(tmpdir(), "verder-zip-"));
    const path = join(dir, "t.zip");
    writeFileSync(path, zip);
    expect(execFileSync("unzip", ["-p", path, "a.txt"]).toString()).toBe("hallo");
  });

  it("refuses an empty archive", () => {
    expect(() => buildZip([])).toThrow(/lege zip/i);
  });

  it("refuses more entries than the cap", () => {
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) =>
      ({ name: `f${i}.txt`, bytes: bytes("x"), at: AT }));
    expect(() => buildZip(many)).toThrow(/bestanden|entries/i);
  });

  it("keeps every entry's offset correct across a multi-entry archive, including an empty one and a non-ASCII name", () => {
    const nonAscii = "Bèschikking — kwijtschelding.pdf";
    const zip = buildZip([
      { name: "eerste.txt", bytes: bytes("een"), at: AT },
      { name: "tweede.pdf", bytes: bytes("%PDF-1.4 fake"), at: AT },
      { name: nonAscii, bytes: bytes("niet-ascii"), at: AT },
      { name: "leeg.txt", bytes: new Uint8Array(), at: AT },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "verder-zip-"));
    const path = join(dir, "t.zip");
    writeFileSync(path, zip);
    expect(() => execFileSync("unzip", ["-t", path])).not.toThrow();
    expect(execFileSync("unzip", ["-p", path, "eerste.txt"]).toString()).toBe("een");
    expect(execFileSync("unzip", ["-p", path, "tweede.pdf"]).toString()).toBe("%PDF-1.4 fake");
    // The third and fourth entries are asserted explicitly: an offset bug in the
    // central directory typically leaves entry 0 correct and corrupts everything
    // after it, so a test that only checks the first entry cannot catch it.
    // The non-ASCII entry is matched with a glob rather than the literal name.
    // Measured: the bytes this writer stores are correct — Python's zipfile
    // (a strict central-directory reader) decodes the name back exactly —
    // but Apple's unzip 6.00 cannot match a UTF-8-flagged non-ASCII name by
    // an exact literal argument on this machine; that is a read-side tool
    // quirk, not a writer defect. The glob still resolves through the same
    // central-directory lookup, so it still exercises this entry's offset.
    expect(execFileSync("unzip", ["-p", path, "B*kwijtschelding.pdf"]).toString()).toBe("niet-ascii");
    expect(execFileSync("unzip", ["-p", path, "leeg.txt"]).toString()).toBe("");
  });

  it("builds and reads back a single-entry archive", () => {
    const zip = buildZip([{ name: "enkel.txt", bytes: bytes("solo"), at: AT }]);
    const dir = mkdtempSync(join(tmpdir(), "verder-zip-"));
    const path = join(dir, "t.zip");
    writeFileSync(path, zip);
    expect(() => execFileSync("unzip", ["-t", path])).not.toThrow();
    expect(execFileSync("unzip", ["-p", path, "enkel.txt"]).toString()).toBe("solo");
  });
});

describe("zipEntryName", () => {
  it("gives a title the extension its mime implies", () => {
    expect(zipEntryName("Beschikking", "application/pdf", new Set())).toBe("Beschikking.pdf");
  });

  it("does not double an extension the title already has", () => {
    expect(zipEntryName("Beschikking.pdf", "application/pdf", new Set()))
      .toBe("Beschikking.pdf");
  });

  // A title is user text and reaches a filesystem. A slash or a .. would let it
  // choose where it lands when the archive is unpacked.
  it("strips anything that would escape the archive", () => {
    expect(zipEntryName("../../etc/passwd", "application/pdf", new Set()))
      .toBe("etc passwd.pdf");
  });

  it("deduplicates, because two documents are often called the same thing", () => {
    const taken = new Set<string>();
    expect(zipEntryName("Beschikking", "application/pdf", taken)).toBe("Beschikking.pdf");
    expect(zipEntryName("Beschikking", "application/pdf", taken)).toBe("Beschikking (2).pdf");
    expect(zipEntryName("Beschikking", "application/pdf", taken)).toBe("Beschikking (3).pdf");
  });

  it("falls back to .bin for a mime it does not know", () => {
    expect(zipEntryName("Iets", "application/x-weird", new Set())).toBe("Iets.bin");
  });

  it("deduplicates case-insensitively, since a filesystem often is", () => {
    const taken = new Set<string>();
    expect(zipEntryName("Report", "application/pdf", taken)).toBe("Report.pdf");
    expect(zipEntryName("REPORT", "application/pdf", taken)).toBe("REPORT (2).pdf");
    expect(zipEntryName("report", "application/pdf", taken)).toBe("report (3).pdf");
  });
});
