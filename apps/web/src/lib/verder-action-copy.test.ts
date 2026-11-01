import { describe, expect, it } from "vitest";
import { verderActionChanges, verderActionHeadline, verderActionNote } from "./verder-action-copy";

const s = (status: string, title: string | null, docType: string | null) => ({ status, title, docType });

describe("verder action copy", () => {
  it("an auto-file names the status and the soort, not an unchanged name", () => {
    expect(verderActionChanges({ before: s("inbox", "a.pdf", null), after: s("filed", "a.pdf", "Loonstrook") }))
      .toEqual(["inbox → opgeborgen", "soort zonder soort → Loonstrook"]);
    expect(verderActionHeadline({ kind: "auto-file" })).toBe("Opgeborgen door verder");
  });

  it("an empty soort reads as no soort, the same branch as null", () => {
    expect(verderActionChanges({ before: s("inbox", "a", ""), after: s("inbox", "a", null) })).toEqual([]);
  });

  it("an auto-name names the rename", () => {
    expect(verderActionChanges({ before: s("inbox", "scan1.pdf", null), after: s("inbox", "Brief.pdf", null) }))
      .toEqual(["naam scan1.pdf → Brief.pdf"]);
    expect(verderActionHeadline({ kind: "auto-name" })).toBe("Hernoemd door verder");
  });

  it("the note says why the button is off, and an undo wins", () => {
    expect(verderActionNote({ undone: false, notUndoableReason: null })).toBeNull();
    expect(verderActionNote({ undone: true, notUndoableReason: "al aangepast" })).toBe("Ongedaan gemaakt");
    expect(verderActionNote({ undone: false, notUndoableReason: "vernietigd" })).toBe("Vernietigd");
    expect(verderActionNote({ undone: false, notUndoableReason: "naam staat ook op de NAS" }))
      .toContain("normalize-names --undo");
  });
});
