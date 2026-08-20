import { describe, expect, it } from "vitest";
import { SEARCH_ENTITY_TYPES, SEARCH_STATUSES } from "@verder/core";
import {
  ENTITY_BADGE, ENTITY_LABEL, MATCH_BADGE, MATCH_LABEL, STATUS_FILTERS,
} from "./search-kinds";

describe("search-kinds", () => {
  it("labels and colours every entity type the router accepts", () => {
    for (const t of SEARCH_ENTITY_TYPES) {
      expect(ENTITY_LABEL[t], t).toBeTruthy();
      expect(ENTITY_BADGE[t], t).toBeTruthy();
    }
  });

  it("labels and colours every matchedBy value", () => {
    for (const m of ["keyword", "semantic", "both"] as const) {
      expect(MATCH_LABEL[m], m).toBeTruthy();
      expect(MATCH_BADGE[m], m).toBeTruthy();
    }
  });

  // The whole point of deriving the rail from SEARCH_STATUSES: the UI can never
  // offer a value the router's z.enum rejects, and can never quietly omit one.
  it("offers exactly the statuses the router accepts — no more, no less", () => {
    expect(STATUS_FILTERS.map((s) => s.value)).toEqual([...SEARCH_STATUSES]);
  });

  it("names the record type in every status label, because statuses are per type", () => {
    for (const s of STATUS_FILTERS) expect(s.label, s.value).toContain(" — ");
  });
});
