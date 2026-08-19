// Shared timeline-event kind constants. Deliberately NOT in the "use client"
// editor module: exports of a client module reach server components as client
// references, so a plain object imported from there renders as a function
// instead of its value.

export const EVENT_KINDS = ["process", "mail", "call", "meeting", "document", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const KIND_LABEL: Record<string, string> = {
  process: "Process", mail: "Mail", call: "Call",
  meeting: "Meeting", document: "Document", other: "Other",
};

export const KIND_BADGE: Record<string, string> = {
  process: "bg-indigo-100 text-indigo-800",
  mail: "bg-amber-100 text-amber-800",
  call: "bg-sky-100 text-sky-800",
  meeting: "bg-violet-100 text-violet-800",
  document: "bg-emerald-100 text-emerald-800",
  other: "bg-slate-100 text-slate-700",
};
