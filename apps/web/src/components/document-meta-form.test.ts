import { describe, expect, it } from "vitest";
import { discardAction, senderOptions } from "./document-meta-form-actions";

describe("discardAction", () => {
  it("offers Wegleggen on a document still in the inbox", () => {
    expect(discardAction("inbox", "inbox")).toEqual({ label: "Wegleggen", next: "discarded" });
  });

  it("offers Wegleggen on a filed document too", () => {
    expect(discardAction("filed", "inbox")).toEqual({ label: "Wegleggen", next: "discarded" });
  });

  it("offers Terugzetten on an already-discarded document", () => {
    expect(discardAction("discarded", "inbox"))
      .toEqual({ label: "Terugzetten", next: "inbox" });
  });

  it("undoes back to FILED when that is what the document was before", () => {
    // Undo must restore the state that preceded the discard. Always returning
    // to "inbox" silently unfiles a filed Beschikking that was discarded by
    // mistake — it reappears in the vault inbox and in the dashboard's inbox
    // tile, and Martin has to file it again. The same commit argues title and
    // docType must ride along across a reversible action; the filed state, the
    // one thing the status column exists to hold, gets the same treatment.
    expect(discardAction("discarded", "filed"))
      .toEqual({ label: "Terugzetten", next: "filed" });
  });

  it("never undoes into another discard", () => {
    // Defensive: a history ending discarded → discarded would otherwise offer
    // an Undo button that changes nothing.
    expect(discardAction("discarded", "discarded"))
      .toEqual({ label: "Terugzetten", next: "inbox" });
  });
});

describe("senderOptions", () => {
  it("offers every party as a sender and pre-selects the one on the document", () => {
    // The form is a client component; this test asserts the pure helper it uses.
    expect(senderOptions([{ id: "p1", name: "Woonhave" }], "p1")[0])
      .toEqual({ value: "p1", label: "Woonhave", selected: true });
  });

  it("selects nothing when the document has no known sender", () => {
    expect(senderOptions([{ id: "p1", name: "Woonhave" }], null)[0])
      .toEqual({ value: "p1", label: "Woonhave", selected: false });
  });

  it("keeps every party in the list regardless of selection", () => {
    expect(senderOptions(
      [{ id: "p1", name: "Woonhave" }, { id: "p2", name: "VerderGroep" }], "p2",
    )).toEqual([
      { value: "p1", label: "Woonhave", selected: false },
      { value: "p2", label: "VerderGroep", selected: true },
    ]);
  });
});
