import { describe, expect, it } from "vitest";
import { voiceSummary, VOICE_SUMMARY_MAX } from "./voice-summary";

describe("voiceSummary", () => {
  it("takes the first sentence", () => {
    expect(voiceSummary("Gebeld met Verder over de loonstroken. Ze sturen een mail.")).toBe(
      "Gebeld met Verder over de loonstroken.");
  });

  it("summary cuts at a word under 120", () => {
    const long = "Gebeld met de bewindvoerder over de loonstroken van juni juli augustus en september "
      + "en over de vraag of het leefgeld volgende week eerder kan komen omdat de huur dan afgaat";
    const out = voiceSummary(long);
    expect(out.length).toBeLessThanOrEqual(VOICE_SUMMARY_MAX);
    expect(out.endsWith("…")).toBe(true);
    // Cut on a word boundary: the text before the ellipsis is a prefix of the
    // transcript that ends exactly where a word ends.
    const kept = out.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(" ");
  });

  it("collapses whitespace and trims", () => {
    expect(voiceSummary("  Belde   CAK\nover de rekening  ")).toBe("Belde CAK over de rekening");
  });

  it("a single word longer than the limit is cut hard rather than emptied", () => {
    const out = voiceSummary("x".repeat(300));
    expect(out.length).toBeLessThanOrEqual(VOICE_SUMMARY_MAX);
    expect(out.length).toBeGreaterThan(1);
  });

  it("an empty transcript gives a fixed label, never an empty summary", () => {
    expect(voiceSummary("   ")).toBe("Gesprek (spraaknotitie)");
  });

  it("does not take a decimal point or an abbreviation for a sentence end", () => {
    expect(voiceSummary("Betaald € 12.50 aan CAK vandaag. Rest volgt.")).toBe(
      "Betaald € 12.50 aan CAK vandaag.");
  });
});
