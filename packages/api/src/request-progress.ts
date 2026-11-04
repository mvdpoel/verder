/**
 * WHAT GRIP IS DOING WITH A REQUEST, IN ONE DUTCH LINE (Vraag Grip spec,
 * "Answer screen": "leest 4 documenten, zoekt in Gmail").
 *
 * Read from the request's `tool_log`, which `grip-tools` appends to per call,
 * so the phone can poll GET /requests/<id> while the runner works. Pure: no DB.
 *
 * The line names activity only — never a title, a party or an amount — because
 * it is shown on a screen that may be glanced at, and because what Grip READ is
 * not yet what it FOUND.
 */

export interface ToolLogLike { tool: string; error?: string }

export interface RequestProgress {
  /** Tool calls made so far, refused ones included. */
  calls: number;
  documents: number;
  mails: number;
  gmail: number;
  /** "leest 4 documenten, zoekt in Gmail"; null before the first call. */
  line: string | null;
  lastTool: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function requestProgress(log: readonly ToolLogLike[]): RequestProgress {
  const count = (...tools: string[]) => log.filter((c) => !c.error && tools.includes(c.tool)).length;
  const documents = count("get_document");
  const mails = count("get_mail");
  const gmail = count("gmail_search", "gmail_read");
  const parts: string[] = [];
  if (documents > 0) parts.push(`leest ${plural(documents, "document", "documenten")}`);
  if (mails > 0) parts.push(`leest ${plural(mails, "mail", "mails")}`);
  if (gmail > 0) parts.push("zoekt in Gmail");
  if (count("search", "list_documents", "list_mail") > 0 && documents === 0 && mails === 0) {
    parts.push("zoekt in het dossier");
  }
  if (count("list_transactions") > 0) parts.push("bekijkt de bankafschriften");
  if (count("get_party", "list_parties", "list_debts") > 0) parts.push("bekijkt partijen en vorderingen");
  if (count("case_map", "list_tasks", "list_entries") > 0) parts.push("bekijkt de zaak");
  return {
    calls: log.length, documents, mails, gmail,
    line: parts.length ? parts.slice(0, 3).join(", ") : null,
    lastTool: log.length ? log[log.length - 1].tool : null,
  };
}

/** The Dutch word the phone shows for a failed request. The stored `error`
 *  is the validator's or runner's English reason, kept for the record. */
export function requestFailureText(error: string | null): string {
  if (!error) return "Lukte niet";
  if (/^(runner: )?(timeout|claude-exit-124|stuck)/.test(error)) return "Duurde te lang";
  return "Lukte niet";
}

/** One line of "Wat Grip nu doet" / "Wat Grip deed" (the answer screen's
 *  stappenlog, frames "antwoord · bezig" and "antwoord · lukte niet"). */
export interface RequestActivityStep {
  /** Dutch, activity only — never a title, a party or an amount. */
  label: string;
  /** done: a finished kind of work; current: the one Grip is on now;
   *  failed: every call of that kind was refused. */
  state: "done" | "current" | "failed";
}

export interface ActivityLogLike extends ToolLogLike { ids?: readonly { type: string; id: string }[] }

type Kind = "documents" | "mail" | "gmail" | "bank" | "parties" | "case" | "search";
const KIND_OF: Record<string, Kind> = {
  get_document: "documents", list_documents: "search", search: "search",
  get_mail: "mail", list_mail: "mail", gmail_search: "gmail", gmail_read: "gmail",
  list_transactions: "bank", get_party: "parties", list_parties: "parties", list_debts: "parties",
  case_map: "case", list_tasks: "case", list_entries: "case",
};

/**
 * The tool log as a short list of kinds of work, in the order Grip began them.
 * While Grip works (`finished` false) the newest kind is `current` and reads
 * in the present ("Zoekt live in Gmail…"); once it stopped, every line reads in
 * the past ("Las 4 documenten"), and a kind whose every call was refused reads
 * as what went wrong ("Gmail gaf geen antwoord").
 */
export function requestActivity(log: readonly ActivityLogLike[], finished: boolean): RequestActivityStep[] {
  const order: Kind[] = [];
  const ok = new Map<Kind, number>();
  const failed = new Map<Kind, number>();
  const found = new Map<Kind, Set<string>>();
  for (const c of log) {
    const k = KIND_OF[c.tool];
    if (!k) continue;
    if (!order.includes(k)) order.push(k);
    if (c.error) { failed.set(k, (failed.get(k) ?? 0) + 1); continue; }
    ok.set(k, (ok.get(k) ?? 0) + 1);
    const ids = found.get(k) ?? new Set<string>();
    for (const r of c.ids ?? []) if (r.type !== "address") ids.add(`${r.type}:${r.id}`);
    found.set(k, ids);
  }
  return order.map((k, i): RequestActivityStep => {
    const n = ok.get(k) ?? 0;
    const hits = found.get(k)?.size ?? 0;
    const now = !finished && i === order.length - 1;
    if (n === 0 && (failed.get(k) ?? 0) > 0) {
      return { label: k === "gmail" ? "Gmail gaf geen antwoord" : "Dit lukte niet", state: "failed" };
    }
    const docs = log.filter((c) => !c.error && c.tool === "get_document").length;
    const label = ((): string => {
      switch (k) {
        case "documents": return now ? `Leest ${plural(docs, "document", "documenten")}` : `${finished ? "Las" : "Leest"} ${plural(docs, "document", "documenten")}`;
        case "mail": return `${finished ? "Zocht" : "Zoekt"} in je dossier (mail)${hits > 0 ? ` · ${hits} gevonden` : ""}`;
        case "gmail": return now ? "Zoekt live in Gmail…" : `${finished ? "Zocht" : "Zoekt"} live in Gmail`;
        case "bank": return `${finished ? "Bekeek" : "Bekijkt"} je bankafschriften${now ? "…" : ""}`;
        case "parties": return `${finished ? "Bekeek" : "Bekijkt"} partijen en vorderingen${now ? "…" : ""}`;
        case "case": return `${finished ? "Bekeek" : "Bekijkt"} de zaak${now ? "…" : ""}`;
        case "search": return `${finished ? "Zocht" : "Zoekt"} in je dossier${now ? "…" : ""}`;
      }
    })();
    return { label, state: now ? "current" : "done" };
  });
}

/** "Wat er gebeurde" on the failed answer screen: what went wrong, in Martin's
 *  words, and what did NOT happen. Never the stored English reason. */
export function requestFailureDetail(error: string | null): string {
  if (requestFailureText(error) === "Duurde te lang") {
    return "Grip zocht langer dan 10 minuten en is gestopt. Er is niets verstuurd en niets veranderd.";
  }
  return "Grip kwam niet tot een antwoord dat klopt met je dossier. Er is niets verstuurd en niets veranderd.";
}
