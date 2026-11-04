import { describe, expect, it } from "vitest";
import { gripActionChanges, gripActionHeadline, gripActionNote } from "./grip-action-copy";

const s = (status: string, title: string | null, docType: string | null) => ({ status, title, docType });

describe("Grip action copy", () => {
  it("an auto-file names the status and the soort, not an unchanged name", () => {
    expect(gripActionChanges({ before: s("inbox", "a.pdf", null), after: s("filed", "a.pdf", "Loonstrook") }))
      .toEqual(["inbox → opgeborgen", "soort zonder soort → Loonstrook"]);
    expect(gripActionHeadline({ kind: "auto-file" })).toBe("Opgeborgen door Grip");
  });

  it("an empty soort reads as no soort, the same branch as null", () => {
    expect(gripActionChanges({ before: s("inbox", "a", ""), after: s("inbox", "a", null) })).toEqual([]);
  });

  it("an auto-name names the rename", () => {
    expect(gripActionChanges({ before: s("inbox", "scan1.pdf", null), after: s("inbox", "Brief.pdf", null) }))
      .toEqual(["naam scan1.pdf → Brief.pdf"]);
    expect(gripActionHeadline({ kind: "auto-name" })).toBe("Hernoemd door Grip");
  });

  it("the note says why the button is off, and an undo wins", () => {
    expect(gripActionNote({ undone: false, notUndoableReason: null })).toBeNull();
    expect(gripActionNote({ undone: true, notUndoableReason: "al aangepast" })).toBe("Ongedaan gemaakt");
    expect(gripActionNote({ undone: false, notUndoableReason: "vernietigd" })).toBe("Vernietigd");
    expect(gripActionNote({ undone: false, notUndoableReason: "naam staat ook op de NAS" }))
      .toContain("normalize-names --undo");
  });
});
