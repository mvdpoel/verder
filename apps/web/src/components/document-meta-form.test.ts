import { describe, expect, it } from "vitest";
import { discardAction } from "./document-meta-form-actions";

describe("discardAction", () => {
  it("offers Discard on a document still in the inbox", () => {
    expect(discardAction("inbox", "inbox")).toEqual({ label: "Discard", next: "discarded" });
  });

  it("offers Discard on a filed document too", () => {
    expect(discardAction("filed", "inbox")).toEqual({ label: "Discard", next: "discarded" });
  });

  it("offers Undo discard on an already-discarded document", () => {
    expect(discardAction("discarded", "inbox"))
      .toEqual({ label: "Undo discard", next: "inbox" });
  });

  it("undoes back to FILED when that is what the document was before", () => {
    // Undo must restore the state that preceded the discard. Always returning
    // to "inbox" silently unfiles a filed Beschikking that was discarded by
    // mistake — it reappears in the vault inbox and in the dashboard's inbox
    // tile, and Martin has to file it again. The same commit argues title and
    // docType must ride along across a reversible action; the filed state, the
    // one thing the status column exists to hold, gets the same treatment.
    expect(discardAction("discarded", "filed"))
      .toEqual({ label: "Undo discard", next: "filed" });
  });

  it("never undoes into another discard", () => {
    // Defensive: a history ending discarded → discarded would otherwise offer
    // an Undo button that changes nothing.
    expect(discardAction("discarded", "discarded"))
      .toEqual({ label: "Undo discard", next: "inbox" });
  });
});
