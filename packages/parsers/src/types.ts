/** One normalized statement line. Amounts are signed integer cents: debits negative. */
export interface ParsedRow {
  rowIndex: number;
  bookedAt: Date;
  amountCents: number;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  description: string | null;
  mandateId: string | null;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Malformed lines are reported here (never silently dropped, never thrown per-row). */
  errors: { rowIndex: number; raw: string; message: string }[];
}

export type StatementSource = "abn-camt053" | "abn-tsv" | "paypal-csv";

/**
 * Best-effort format sniff from the filename plus the first bytes of the file.
 * Content wins over extension; returns null when neither is conclusive.
 */
export function detectSource(filename: string, head: Buffer): StatementSource | null {
  const name = filename.toLowerCase();
  let text = head.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM (PayPal)

  if (text.includes("BkToCstmrStmt") || /^\s*<\?xml/.test(text) || name.endsWith(".xml")) {
    return "abn-camt053";
  }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if ((firstLine.match(/\t/g)?.length ?? 0) >= 7) return "abn-tsv";
  if (/"?date"?\s*,/i.test(firstLine) && /transaction/i.test(firstLine)) return "paypal-csv";
  if (name.endsWith(".tsv") || name.endsWith(".tab")) return "abn-tsv";
  if (name.endsWith(".csv")) return "paypal-csv";
  return null;
}
