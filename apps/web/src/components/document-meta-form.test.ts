import { describe, expect, it } from "vitest";
import { discardAction } from "./document-meta-form-actions";

describe("discardAction", () => {
  it("offers Discard on a document still in the inbox", () => {
    expect(discardAction("inbox")).toEqual({ label: "Discard", next: "discarded" });
  });

  it("offers Discard on a filed document too", () => {
    expect(discardAction("filed")).toEqual({ label: "Discard", next: "discarded" });
  });

  it("offers Undo discard on an already-discarded document", () => {
    expect(discardAction("discarded")).toEqual({ label: "Undo discard", next: "inbox" });
  });
});
