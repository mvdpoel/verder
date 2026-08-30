/**
 * Everything /files shows comes from the URL and is rendered on the server, so
 * a link Martin sends himself reproduces exactly this view — the same rule
 * /search follows. The checkbox selection is the one exception: a sixty-item
 * selection in a query string is a URL nobody can share anyway.
 *
 * Nonsense in the URL falls back to "alles" here rather than reaching the
 * router and returning a BAD_REQUEST Martin would have to decode.
 */

export type Branch =
  | { kind: "alles" }
  | { kind: "bundels" }
  | { kind: "bundel"; id: string }
  | { kind: "soort"; key: string }
  | { kind: "party"; id: string | null }
  | { kind: "periode"; month: string }
  | { kind: "bron"; source: "upload" | "nas-scan" | "email-attachment" }
  | { kind: "status"; status: "inbox" | "filed" | "discarded" };

export const SORTS = ["naam", "soort", "van", "datum", "grootte"] as const;
export type Sort = (typeof SORTS)[number];

export interface ParsedFiles {
  branch: Branch; sort: Sort; dir: "asc" | "desc"; sel: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-\d{2}$/;
const SOURCES = ["upload", "nas-scan", "email-attachment"] as const;
const STATUSES = ["inbox", "filed", "discarded"] as const;

export function encodeBranch(b: Branch): string {
  switch (b.kind) {
    case "alles": return "";
    case "bundels": return "bundels";
    case "bundel": return `bundel:${b.id}`;
    case "soort": return `soort:${b.key}`;
    case "party": return `party:${b.id ?? "onbekend"}`;
    case "periode": return `periode:${b.month}`;
    case "bron": return `bron:${b.source}`;
    case "status": return `status:${b.status}`;
  }
}

export function decodeBranch(raw: string): Branch {
  if (!raw) return { kind: "alles" };
  if (raw === "bundels") return { kind: "bundels" };
  // Split on the FIRST colon only: a soort is free text and may contain one.
  const i = raw.indexOf(":");
  if (i < 0) return { kind: "alles" };
  const kind = raw.slice(0, i);
  const v = raw.slice(i + 1);
  if (kind === "bundel") return UUID.test(v) ? { kind: "bundel", id: v } : { kind: "alles" };
  if (kind === "soort") return v ? { kind: "soort", key: v } : { kind: "alles" };
  if (kind === "party") {
    if (v === "onbekend") return { kind: "party", id: null };
    return UUID.test(v) ? { kind: "party", id: v } : { kind: "alles" };
  }
  if (kind === "periode") return MONTH.test(v) ? { kind: "periode", month: v } : { kind: "alles" };
  if (kind === "bron") {
    return (SOURCES as readonly string[]).includes(v)
      ? ({ kind: "bron", source: v } as Branch) : { kind: "alles" };
  }
  if (kind === "status") {
    return (STATUSES as readonly string[]).includes(v)
      ? ({ kind: "status", status: v } as Branch) : { kind: "alles" };
  }
  return { kind: "alles" };
}

function one(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return (raw ?? "").trim();
}

export function parseFilesParams(
  sp: Record<string, string | string[] | undefined>,
): ParsedFiles {
  const sort = one(sp.sort);
  const dir = one(sp.dir);
  return {
    branch: decodeBranch(one(sp.tak)),
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as Sort) : "datum",
    dir: dir === "asc" ? "asc" : "desc",
    sel: one(sp.sel),
  };
}

export function buildFilesHref(
  p: ParsedFiles,
  override: Partial<ParsedFiles> = {},
): string {
  const next = { ...p, ...override };
  const qs = new URLSearchParams();
  const tak = encodeBranch(next.branch);
  if (tak) qs.set("tak", tak);
  if (next.sort !== "datum") qs.set("sort", next.sort);
  if (next.dir !== "desc") qs.set("dir", next.dir);
  if (next.sel) qs.set("sel", next.sel);
  const s = qs.toString();
  return s ? `/files?${s}` : "/files";
}
