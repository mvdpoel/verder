import { describe, expect, it } from "vitest";
import { SEARCH_ENTITY_TYPES, SEARCH_STATUSES } from "./entity-types";

describe("SEARCH_ENTITY_TYPES", () => {
  it("is the nine indexed entity types, in the order the schema and the UI use", () => {
    expect([...SEARCH_ENTITY_TYPES]).toEqual([
      "document", "entry", "email", "financial_item", "debt",
      "task", "milestone", "timeline_event", "party"]);
  });
});

describe("SEARCH_STATUSES", () => {
  it("is the deduped union of every status vocabulary in the app", () => {
    // doc_status | TASK_STATUSES | item_status | debt_status, "identified"
    // shared between items and debts and therefore listed once.
    expect([...SEARCH_STATUSES]).toEqual([
      "inbox", "filed",
      "open", "in-progress", "waiting", "done", "dropped",
      "identified", "mandatory", "allowed", "requested", "to-cancel", "canceled",
      "acknowledged", "disputed", "in-settlement", "settled"]);
  });

  it("contains no duplicates", () => {
    expect(new Set(SEARCH_STATUSES).size).toBe(SEARCH_STATUSES.length);
  });
});
