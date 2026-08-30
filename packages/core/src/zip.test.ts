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
});
