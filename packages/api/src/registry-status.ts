// Pure status logic for the financial registry (no DB access).
// Statuses are process steps, not verdicts; the edge matrices below come from
// the design spec and are enforced by decide() — with a recorded override as
// the only escape hatch.

export type ItemStatus =
  | "identified" | "mandatory" | "allowed" | "requested" | "to-cancel" | "canceled";
export type DebtStatus =
  | "identified" | "acknowledged" | "disputed" | "in-settlement" | "settled";

export const ITEM_STATUSES: readonly ItemStatus[] =
  ["identified", "mandatory", "allowed", "requested", "to-cancel", "canceled"];
export const DEBT_STATUSES: readonly DebtStatus[] =
  ["identified", "acknowledged", "disputed", "in-settlement", "settled"];

const ITEM_EDGES: Record<ItemStatus, readonly ItemStatus[]> = {
  identified: ["mandatory", "allowed", "requested", "to-cancel"],
  mandatory: ["allowed"],
  allowed: ["mandatory", "requested", "to-cancel"],
  requested: ["allowed", "to-cancel"],
  "to-cancel": ["canceled", "allowed"],
  canceled: [],
};

const DEBT_EDGES: Record<DebtStatus, readonly DebtStatus[]> = {
  identified: ["acknowledged", "disputed"],
  acknowledged: ["disputed", "in-settlement"],
  disputed: ["acknowledged", "in-settlement"],
  "in-settlement": ["settled"],
  settled: [],
};

export function isValidTransition(kind: "item" | "debt", from: string, to: string): boolean {
  const edges: Record<string, readonly string[]> = kind === "item" ? ITEM_EDGES : DEBT_EDGES;
  return edges[from]?.includes(to) ?? false;
}
