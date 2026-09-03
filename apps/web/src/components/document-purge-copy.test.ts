import { describe, expect, it } from "vitest";
import { purgeTombstoneLine } from "./document-purge-copy";

describe("purgeTombstoneLine", () => {
  const at = new Date("2026-09-03T14:05:00+02:00");

  it("names the date and the reason", () => {
    expect(purgeTombstoneLine({ at, reason: "per ongeluk gescand", sizeBytes: 2048 }))
      .toBe("Definitief verwijderd op 03-09-2026 — per ongeluk gescand");
  });

  // A missing reason must not render a dangling dash. The field is optional by
  // design, so the blank case is the normal one, not the edge one.
  it("omits the dash when no reason was given", () => {
    expect(purgeTombstoneLine({ at, reason: null, sizeBytes: 2048 }))
      .toBe("Definitief verwijderd op 03-09-2026");
  });

  // Dutch date order, and Amsterdam time. A purge at 00:30 CEST is the 3rd
  // here and the 2nd in UTC, and the tombstone is read by someone in Almere.
  it("renders the date in Amsterdam time", () => {
    expect(purgeTombstoneLine({
      at: new Date("2026-09-02T23:30:00Z"), reason: null, sizeBytes: 1 }))
      .toBe("Definitief verwijderd op 03-09-2026");
  });
});
