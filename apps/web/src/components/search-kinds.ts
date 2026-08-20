import { SEARCH_STATUSES, type SearchEntityType, type SearchStatus } from "@verder/core";

// Shared search constants. Deliberately NOT a "use client" module: both the
// server-rendered /search page and the client command palette import it, and
// exports of a client module reach server components as client references
// instead of their values (same reason as components/timeline-kinds.ts).

export const ENTITY_LABEL: Record<SearchEntityType, string> = {
  document: "Document",
  entry: "Logbook",
  email: "E-mail",
  financial_item: "Registry item",
  debt: "Debt",
  task: "Task",
  milestone: "Milestone",
  timeline_event: "Key event",
  party: "Party",
};

export const ENTITY_BADGE: Record<SearchEntityType, string> = {
  document: "bg-emerald-100 text-emerald-800",
  entry: "bg-sky-100 text-sky-800",
  email: "bg-amber-100 text-amber-800",
  financial_item: "bg-indigo-100 text-indigo-800",
  debt: "bg-red-100 text-red-700",
  task: "bg-violet-100 text-violet-800",
  milestone: "bg-teal-100 text-teal-800",
  timeline_event: "bg-orange-100 text-orange-800",
  party: "bg-slate-100 text-slate-700",
};

// Why a result matched — the point is that Martin can see it, not guess it.
export const MATCH_LABEL: Record<"keyword" | "semantic" | "both", string> = {
  keyword: "keyword", semantic: "semantic", both: "keyword + semantic",
};
export const MATCH_BADGE: Record<"keyword" | "semantic" | "both", string> = {
  keyword: "bg-slate-100 text-slate-600",
  semantic: "bg-purple-100 text-purple-700",
  both: "bg-green-100 text-green-700",
};

// Statuses are per entity type, so picking one implicitly narrows the results
// to the types that carry it — the labels say which. Typing this as a full
// Record<SearchStatus, string> means adding a status in @verder/core without a
// label here is a compile error, not a blank <option>.
const STATUS_LABEL: Record<SearchStatus, string> = {
  inbox: "Document — inbox",
  filed: "Document — filed",
  open: "Task — open",
  "in-progress": "Task — in progress",
  waiting: "Task — waiting on someone",
  done: "Task — done",
  dropped: "Task — dropped",
  identified: "Registry — identified (item or debt)",
  mandatory: "Registry item — mandatory",
  allowed: "Registry item — allowed",
  requested: "Registry item — cancellation requested",
  "to-cancel": "Registry item — to cancel",
  canceled: "Registry item — canceled",
  acknowledged: "Debt — acknowledged",
  disputed: "Debt — disputed",
  "in-settlement": "Debt — in settlement",
  settled: "Debt — settled",
};

/** The status rail, derived from the router's own vocabulary so it can never drift. */
export const STATUS_FILTERS: readonly { value: SearchStatus; label: string }[] =
  SEARCH_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] }));
