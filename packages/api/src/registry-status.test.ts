import { describe, expect, it } from "vitest";
import { isValidTransition, type DebtStatus, type ItemStatus } from "./registry-status";

// Full edge matrix from the design spec:
// item:  identified→{mandatory,allowed,requested,to-cancel}; mandatory↔allowed;
//        allowed→{requested,to-cancel}; requested→{allowed,to-cancel};
//        to-cancel→{canceled,allowed}; canceled→(none)
// debt:  identified→{acknowledged,disputed}; acknowledged↔disputed;
//        acknowledged→in-settlement; disputed→in-settlement;
//        in-settlement→settled; settled→(none)

const ITEM_STATUSES: ItemStatus[] =
  ["identified", "mandatory", "allowed", "requested", "to-cancel", "canceled"];
const DEBT_STATUSES: DebtStatus[] =
  ["identified", "acknowledged", "disputed", "in-settlement", "settled"];

const ITEM_EDGES: Record<ItemStatus, ItemStatus[]> = {
  identified: ["mandatory", "allowed", "requested", "to-cancel"],
  mandatory: ["allowed"],
  allowed: ["mandatory", "requested", "to-cancel"],
  requested: ["allowed", "to-cancel"],
  "to-cancel": ["canceled", "allowed"],
  canceled: [],
};

const DEBT_EDGES: Record<DebtStatus, DebtStatus[]> = {
  identified: ["acknowledged", "disputed"],
  acknowledged: ["disputed", "in-settlement"],
  disputed: ["acknowledged", "in-settlement"],
  "in-settlement": ["settled"],
  settled: [],
};

describe("isValidTransition", () => {
  it("matches the full item edge matrix", () => {
    for (const from of ITEM_STATUSES)
      for (const to of ITEM_STATUSES)
        expect(isValidTransition("item", from, to), `item ${from} → ${to}`)
          .toBe(ITEM_EDGES[from].includes(to));
  });

  it("matches the full debt edge matrix", () => {
    for (const from of DEBT_STATUSES)
      for (const to of DEBT_STATUSES)
        expect(isValidTransition("debt", from, to), `debt ${from} → ${to}`)
          .toBe(DEBT_EDGES[from].includes(to));
  });

  it("no status transitions to itself", () => {
    for (const s of ITEM_STATUSES) expect(isValidTransition("item", s, s)).toBe(false);
    for (const s of DEBT_STATUSES) expect(isValidTransition("debt", s, s)).toBe(false);
  });

  it("unknown statuses are never valid", () => {
    expect(isValidTransition("item", "identified", "nonsense")).toBe(false);
    expect(isValidTransition("item", "nonsense", "allowed")).toBe(false);
    expect(isValidTransition("debt", "identified", "nonsense")).toBe(false);
    expect(isValidTransition("debt", "nonsense", "settled")).toBe(false);
    // statuses from the OTHER kind are unknown for this kind
    expect(isValidTransition("item", "identified", "acknowledged")).toBe(false);
    expect(isValidTransition("debt", "identified", "mandatory")).toBe(false);
  });
});
