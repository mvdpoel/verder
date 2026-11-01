import { describe, expect, it } from "vitest";
import { passesAutoApplyRule, scoreDocMeta, summarizeDocMetaRun, type DocMetaOutcome } from "./docmeta-score";

describe("scoreDocMeta", () => {
  it("docType compares through the soort fold", () => {
    const s = scoreDocMeta({ title: "x", docType: "Loonstrook " }, { title: "x", docType: "loonstrook" });
    expect(s.docTypeExact).toBe(true);
    expect(s.gate).toBe(true);
  });

  it("gate ignores the title", () => {
    const s = scoreDocMeta(
      { title: "Iets heel anders", docType: "loonstrook" },
      { title: "Loonstrook.mp.2026-07.Saurens.pdf", docType: "Loonstrook" });
    expect(s.gate).toBe(true);
    expect(s.titleExact).toBe(false);
  });

  it("null expected docType matches empty output", () => {
    expect(scoreDocMeta({ title: "t", docType: "" }, { title: "t", docType: null }).gate).toBe(true);
    expect(scoreDocMeta({ title: "t", docType: null }, { title: "t", docType: null }).gate).toBe(true);
    expect(scoreDocMeta({ title: "t", docType: "brief" }, { title: "t", docType: null }).gate).toBe(false);
  });

  it("a wrong soort fails the gate even with the exact title", () => {
    const s = scoreDocMeta({ title: "t", docType: "brief" }, { title: "t", docType: "factuur" });
    expect(s).toEqual({ docTypeExact: false, titleExact: true, gate: false });
  });
});

describe("summarizeDocMetaRun", () => {
  const answered = (confident: boolean, gate: boolean, titleExact = false): DocMetaOutcome =>
    ({ kind: "answered", confident, score: { docTypeExact: gate, titleExact, gate } });

  it("separates confident precision from overall precision and counts timeouts apart", () => {
    const sum = summarizeDocMetaRun([
      answered(true, true, true), answered(true, false), answered(false, true),
      answered(false, false), { kind: "timeout" }, { kind: "error" },
    ]);
    expect(sum).toEqual({
      n: 6, answered: 4, timeouts: 1, errors: 1, nConfident: 2,
      gatePrecisionConfident: 0.5, gatePrecisionAll: 0.5, titleExactRate: 0.25,
    });
  });

  it("reports no precision rather than zero when nothing was confident", () => {
    const sum = summarizeDocMetaRun([answered(false, true), { kind: "timeout" }]);
    expect(sum.nConfident).toBe(0);
    expect(sum.gatePrecisionConfident).toBeNull();
    expect(sum.gatePrecisionAll).toBe(1);
  });

  it("an all-timeout run has no rates at all", () => {
    const sum = summarizeDocMetaRun([{ kind: "timeout" }]);
    expect(sum).toMatchObject({ answered: 0, gatePrecisionAll: null, titleExactRate: null });
  });
});

describe("passesAutoApplyRule (Task 13, fixed before looking)", () => {
  const confidentRun = (n: number, right: number): DocMetaOutcome[] =>
    Array.from({ length: n }, (_, i) => ({ kind: "answered", confident: true,
      score: { docTypeExact: i < right, titleExact: false, gate: i < right } }));

  it("needs at least 20 confident answers", () => {
    expect(passesAutoApplyRule(summarizeDocMetaRun(confidentRun(19, 19)))).toBe(false);
    expect(passesAutoApplyRule(summarizeDocMetaRun(confidentRun(20, 18)))).toBe(true);
  });

  it("needs soort precision of at least 0.90 among the confident", () => {
    expect(passesAutoApplyRule(summarizeDocMetaRun(confidentRun(20, 17)))).toBe(false);
  });
});
