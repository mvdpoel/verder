import { describe, expect, it } from "vitest";
import { linkId, linkOptionList } from "@/lib/stop-links";

const rows = [
  { id: "a", label: "Mail Team Opstart" },
  { id: "b", label: "Intake Gemeentehuis" },
];

describe("linkOptionList", () => {
  it("keeps a link the candidate page does not contain", () => {
    // Otherwise the select silently falls back to "— geen —" and the next
    // Opslaan drops a koppeling Martin never saw.
    const list = linkOptionList(rows, { id: "z", label: "Beschikking mei" });
    expect(list.map((o) => o.id)).toEqual(["z", "a", "b"]);
  });

  it("does not list the current link twice when it is on the page", () => {
    const list = linkOptionList(rows, { id: "a", label: "Mail Team Opstart" });
    expect(list.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("leaves the page alone when the halte is linked to nothing", () => {
    expect(linkOptionList(rows, null)).toEqual(rows);
  });
});

describe("linkId", () => {
  it("turns the 'geen' option into an explicit null so a link can be removed", () => {
    // undefined would be stripped by the router's definedOnly and the old
    // koppeling would survive forever.
    expect(linkId("")).toBeNull();
    expect(linkId("   ")).toBeNull();
  });

  it("passes a chosen id through untouched", () => {
    expect(linkId("6f1c0e2a-0000-4000-8000-000000000001"))
      .toBe("6f1c0e2a-0000-4000-8000-000000000001");
  });
});
