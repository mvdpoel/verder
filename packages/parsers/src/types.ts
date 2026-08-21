import { isSpreadsheetMime, sniffContainer } from "./sniff";

/** One normalized statement line. Amounts are signed integer cents: debits negative. */
export interface ParsedRow {
  rowIndex: number;
  bookedAt: Date;
  amountCents: number;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  description: string | null;
  mandateId: string | null;
  /**
   * The account THIS statement belongs to — not the counterparty. CAMT carries
   * it once per Stmt and it is copied onto each row; the ABN exports repeat it
   * in column 0 of every row; PayPal has no such thing and yields null.
   */
  accountIban: string | null;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Malformed lines are reported here (never silently dropped, never thrown per-row). */
  errors: { rowIndex: number; raw: string; message: string }[];
}

export type StatementSource = "abn-camt053" | "abn-tsv" | "paypal-csv" | "abn-xls";

/**
 * How much of a file the TEXT heuristics look at. The container sniff needs
 * the whole buffer (a ZIP scatters its entry names through the file); the text
 * markers all live in the first line or two, and uploads run to 50 MB.
 * Decoding all of one to UTF-8 on the request path would cost ~2 bytes of JS
 * string per byte of file, and would let a token buried deep inside a binary
 * hijack the format decision.
 */
const TEXT_SNIFF_BYTES = 1024;

/**
 * Best-effort format sniff from the filename plus the file's bytes. Content
 * wins over extension; returns null when neither is conclusive.
 *
 * Takes the WHOLE buffer — a spreadsheet is only identifiable from its
 * container, and a ZIP scatters its entry names through the file.
 */
export function detectSource(filename: string, bytes: Buffer): StatementSource | null {
  // Binary containers first: an OLE2 or OOXML file is not text, and running the
  // text heuristics over it can only produce a wrong answer.
  const container = sniffContainer(bytes);
  if (container && isSpreadsheetMime(container)) return "abn-xls";

  const name = filename.toLowerCase();
  let text = bytes.subarray(0, TEXT_SNIFF_BYTES).toString("utf8");
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
