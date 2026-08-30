import { describe, expect, it } from "vitest";
import { buildManifest } from "./zip-manifest";

const ROW = {
  name: "Beschikking.pdf", title: "Beschikking onder bewind",
  docType: "beschikking", partyName: "Rechtbank Midden-Nederland",
  receivedAt: new Date("2026-07-14T09:00:00Z"), sizeBytes: 240_000,
  sha256: "a".repeat(64), discarded: false,
};

describe("buildManifest", () => {
  it("is Dutch, because the reader is", () => {
    const txt = buildManifest([ROW], new Date("2026-08-30T10:00:00Z"));
    expect(txt).toContain("Inhoudsopgave");
    expect(txt).toContain("Beschikking onder bewind");
    expect(txt).toContain("Rechtbank Midden-Nederland");
    expect(txt).toContain("14-07-2026");
    expect(txt).toContain("a".repeat(64));
  });

  it("says 'onbekend' rather than leaving a blank where a sender should be", () => {
    const txt = buildManifest([{ ...ROW, partyName: null }], new Date());
    expect(txt).toContain("onbekend");
  });

  // A deliberate selection may include a discarded document. Including it
  // silently is the lie, not including it.
  it("names a discarded document as discarded", () => {
    const txt = buildManifest([{ ...ROW, discarded: true }], new Date());
    expect(txt).toMatch(/weggelegd/i);
  });

  it("counts what it lists", () => {
    expect(buildManifest([ROW, ROW], new Date())).toContain("2 bestanden");
  });
});
