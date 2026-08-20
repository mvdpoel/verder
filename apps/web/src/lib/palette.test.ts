import { describe, expect, it } from "vitest";
import { flatOrder, groupHits, nextIndex } from "./palette";

const hits = [
  { entityType: "task", entityId: "t1", title: "Kopie paspoort opsturen", href: "/tasks/t1" },
  { entityType: "document", entityId: "d1", title: "Brief VerderGroep", href: "/vault/d1" },
  { entityType: "task", entityId: "t2", title: "Ziggo opzeggen", href: "/tasks/t2" },
];

describe("groupHits", () => {
  it("groups by record type in the fixed SEARCH_ENTITY_TYPES order", () => {
    const groups = groupHits(hits);
    expect(groups.map((g) => g.entityType)).toEqual(["document", "task"]);
    expect(groups[1].hits.map((h) => h.entityId)).toEqual(["t1", "t2"]);
  });

  it("drops empty groups", () => {
    expect(groupHits([])).toEqual([]);
  });
});

describe("flatOrder", () => {
  it("is the order the arrow keys walk", () => {
    expect(flatOrder(groupHits(hits)).map((h) => h.entityId)).toEqual(["d1", "t1", "t2"]);
  });
});

describe("nextIndex", () => {
  it("moves down and wraps at the end", () => {
    expect(nextIndex(3, 0, "ArrowDown")).toBe(1);
    expect(nextIndex(3, 2, "ArrowDown")).toBe(0);
  });
  it("moves up and wraps at the start", () => {
    expect(nextIndex(3, 1, "ArrowUp")).toBe(0);
    expect(nextIndex(3, 0, "ArrowUp")).toBe(2);
  });
  it("stays at 0 for an empty list so the caller never renders a bad index", () => {
    expect(nextIndex(0, 0, "ArrowDown")).toBe(0);
    expect(nextIndex(0, 0, "ArrowUp")).toBe(0);
  });
});
