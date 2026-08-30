import { describe, expect, it } from "vitest";
import { docTypeKey, docTypeLabel } from "./doc-type";

describe("docTypeKey", () => {
  it("folds case, edge whitespace and inner runs into one key", () => {
    expect(docTypeKey("Loonstrook")).toBe("loonstrook");
    expect(docTypeKey("  loonstrook ")).toBe("loonstrook");
    expect(docTypeKey("bank  afschrift")).toBe("bank afschrift");
  });

  it("gives an empty key to a document with no soort", () => {
    expect(docTypeKey(null)).toBe("");
    expect(docTypeKey("   ")).toBe("");
  });
});

describe("docTypeLabel", () => {
  it("picks the spelling most rows actually use", () => {
    expect(docTypeLabel(["loonstrook", "Loonstrook", "Loonstrook"])).toBe("Loonstrook");
  });

  // Deterministic on a tie, or the branch label flickers between page loads
  // and the tree looks like it is changing under the reader.
  it("breaks a tie alphabetically", () => {
    expect(docTypeLabel(["Beschikking", "beschikking"])).toBe("Beschikking");
  });

  // The tie-break must be alphabetical for genuinely different spellings, not
  // merely deterministic — reversing the comparator to make the case test pass
  // silently made this one resolve "Zienswijze".
  it("breaks a tie between different spellings alphabetically", () => {
    expect(docTypeLabel(["Aanmaning", "Zienswijze"])).toBe("Aanmaning");
  });
});
