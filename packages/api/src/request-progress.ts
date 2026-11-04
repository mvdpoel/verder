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
