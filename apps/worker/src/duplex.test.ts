import { describe, expect, it } from "vitest";
import { judgeDuplexPair, pairCandidates, mergedName, SCANNER_NAME, DUPLEX_WINDOW_MS } from "./duplex";

const LETTER = (p: number, y: number) =>
  `Beste heer Van der Poel, hierbij bevestigen wij de ontvangst van uw brief.\nPagina ${p} van ${y}`;
const PLAIN = "Geachte heer, wij bevestigen de afspraak van donderdag en danken u voor uw medewerking.";

describe("judgeDuplexPair", () => {
  it("merges two sheets with blank backs and drops the backs", () => {
    const j = judgeDuplexPair([PLAIN, PLAIN + " twee"], ["", " . "]);
    expect(j.merge).toBe(true);
    expect(j.evidence).toEqual(["blank", "blank"]);
    expect(j.order).toEqual([0, 1]);
  });

  it("interleaves backs in reverse: the back of sheet 0 is the LAST page of the backs file", () => {
    // 2 sheets: fronts are pages 1 and 3, backs 2 and 4 of a four-page letter.
    // Backs file holds sheet 1's back first.
    const j = judgeDuplexPair([LETTER(1, 4), LETTER(3, 4)], [LETTER(4, 4), LETTER(2, 4)]);
    expect(j.merge).toBe(true);
    expect(j.evidence).toEqual(["marker", "marker"]);
    // concatenation [f0 f1 b0 b1] = indices 0..3; sheet 0's back is b1 = 3.
    expect(j.order).toEqual([0, 3, 1, 2]);
  });

  it("keeps a non-blank back next to a blank one", () => {
    const j = judgeDuplexPair([LETTER(1, 3), PLAIN], ["", LETTER(2, 3)]);
    // sheet 0 pairs backs[1] (marker 2/3), sheet 1 pairs backs[0] (blank)
    expect(j.evidence).toEqual(["marker", "blank"]);
    expect(j.order).toEqual([0, 3, 1]);
  });

  it("refuses when a back numbers itself against its front", () => {
    const j = judgeDuplexPair([LETTER(1, 2), LETTER(1, 1)], ["", LETTER(1, 1)]);
    expect(j.evidence).toEqual(["contradiction", "blank"]);
    expect(j.merge).toBe(false);
  });

  it("refuses two unrelated letters that merely have text on both sides", () => {
    const j = judgeDuplexPair([PLAIN], [PLAIN + " ander onderwerp"]);
    expect(j).toMatchObject({ merge: false, evidence: ["neutral"], order: [] });
  });

  it("refuses when the page counts differ, and for no pages", () => {
    expect(judgeDuplexPair([PLAIN, PLAIN], [""]).merge).toBe(false);
    expect(judgeDuplexPair([], []).merge).toBe(false);
  });

  it("does not take the footer-only page for blank", () => {
    // 17 alphanumerics: a page that says only 'Paginanummer 2 van 2' is a page.
    const j = judgeDuplexPair([LETTER(1, 2)], ["Paginanummer 2 van 2"]);
    expect(j.evidence).toEqual(["marker"]);
  });

  it("treats a bare 'Sla om' as blank", () => {
    expect(judgeDuplexPair([PLAIN], ["Sla om"]).evidence).toEqual(["blank"]);
  });
});

describe("pairCandidates", () => {
  const c = (seq: number, t: number, pages = 2) =>
    ({ name: `scan${String(seq).padStart(4, "0")}.pdf`, seq, mtimeMs: t, pages });
  it("pairs consecutive sequence numbers inside the window, lowest first", () => {
    const pairs = pairCandidates([c(3, 5000), c(1, 0), c(2, 1000)]);
    expect(pairs.map(([a, b]) => [a.seq, b.seq])).toEqual([[1, 2]]);
  });
  it("refuses a gap in the sequence, a late second pass, or unequal page counts", () => {
    expect(pairCandidates([c(1, 0), c(3, 1000)])).toEqual([]);
    expect(pairCandidates([c(1, 0), c(2, DUPLEX_WINDOW_MS + 1)])).toEqual([]);
    expect(pairCandidates([c(1, 0, 2), c(2, 1000, 3)])).toEqual([]);
    expect(pairCandidates([c(1, 0, 31), c(2, 1000, 31)])).toEqual([]);
  });
});

describe("names", () => {
  it("the merged name is never a scanner name, and scan_0001.pdf is not one either", () => {
    expect(mergedName("scan0001.pdf", "scan0002.pdf")).toBe("duplex-scan0001-scan0002.pdf");
    expect(SCANNER_NAME.test(mergedName("scan0001.pdf", "scan0002.pdf"))).toBe(false);
    expect(SCANNER_NAME.test("scan_0001.pdf")).toBe(false);
    expect(SCANNER_NAME.test("SCAN0042.PDF")).toBe(true);
  });
});
