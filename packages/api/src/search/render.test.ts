import { describe, expect, it } from "vitest";
import { euro, nlLabel, stripQuotedReply } from "./render";

describe("stripQuotedReply", () => {
  it("cuts a Dutch reply tail", () => {
    const body = [
      "Beste heer Van der Poel,",
      "Bijgaand de bevestiging van de opzegging.",
      "",
      "Op 19 augustus 2026 om 10:12 schreef VerderGroep <info@verdergroep.nl>:",
      "> Kunt u de opzegging bevestigen?",
      "> Met vriendelijke groet",
    ].join("\n");
    expect(stripQuotedReply(body))
      .toBe("Beste heer Van der Poel,\nBijgaand de bevestiging van de opzegging.");
  });

  it("cuts an English reply tail and an Outlook original-message block", () => {
    expect(stripQuotedReply("Thanks, that works.\n\nOn Wed, 19 Aug 2026 at 10:12, X wrote:\n> hi"))
      .toBe("Thanks, that works.");
    expect(stripQuotedReply("Zie bijlage.\n\n-----Oorspronkelijk bericht-----\nVan: iemand"))
      .toBe("Zie bijlage.");
  });

  it("keeps a leading quote block, because cutting there would erase the record", () => {
    expect(stripQuotedReply("> Kunt u dit bevestigen?\n> Groet"))
      .toBe("> Kunt u dit bevestigen?\n> Groet");
  });

  it("leaves an unquoted body untouched apart from trimming", () => {
    expect(stripQuotedReply("  Beste Martin,\n\nGraag een kopie van uw paspoort.  "))
      .toBe("Beste Martin,\n\nGraag een kopie van uw paspoort.");
  });
});

describe("euro / nlLabel", () => {
  it("formats cents the Dutch way", () => {
    expect(euro(4250)).toBe("€ 42,50");
    expect(euro(5)).toBe("€ 0,05");
    expect(euro(-1999)).toBe("-€ 19,99");
  });

  it("renders the stored value with its Dutch label", () => {
    expect(nlLabel("to-cancel")).toBe("to-cancel (op te zeggen)");
    expect(nlLabel("open")).toBe("open");
    expect(nlLabel("iets-onbekends")).toBe("iets-onbekends");
  });
});
