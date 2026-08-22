import { XMLParser } from "fast-xml-parser";
import { normalizeAccount } from "./iban";
import { decimalToCents } from "./money";
import type { ParseResult, ParsedRow } from "./types";

/**
 * CAMT.053 (ISO 20022 bank-to-customer statement) parser, ABN AMRO flavor.
 * One ParsedRow per Ntry/NtryDtls/TxDtls (a batched Ntry fans out into one
 * row per TxDtls, using the TxDtls-level TxAmt when present). Only EUR is
 * accepted; anything else lands in errors[].
 */

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false, // keep amounts as strings — money is string math only
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === "Stmt" || name === "Ntry" || name === "TxDtls" || name === "Ustrd",
});

function asNode(v: unknown): XmlNode | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as XmlNode) : null;
}

function text(v: unknown): string | null {
  if (typeof v === "string") return v.length > 0 ? v : null;
  const node = asNode(v);
  if (node && typeof node["#text"] === "string") return node["#text"] as string;
  return null;
}

/** Amt elements carry a Ccy attribute: { "#text": "142.80", "@_Ccy": "EUR" }. */
function amount(v: unknown): { value: string; ccy: string | null } | null {
  const value = text(v);
  if (value === null) return null;
  const node = asNode(v);
  const ccy = node && typeof node["@_Ccy"] === "string" ? (node["@_Ccy"] as string) : null;
  return { value, ccy };
}

function path(node: XmlNode | null, ...keys: string[]): unknown {
  let cur: unknown = node;
  for (const key of keys) {
    const n = asNode(cur);
    if (!n) return undefined;
    cur = n[key];
  }
  return cur;
}

export function parseCamt053(buf: Buffer): ParseResult {
  const doc = parser.parse(buf.toString("utf8")) as XmlNode;
  const stmts = path(doc, "Document", "BkToCstmrStmt") as XmlNode | undefined;
  const stmtList = (asNode(stmts)?.["Stmt"] ?? []) as unknown[];
  if (!Array.isArray(stmtList) || stmtList.length === 0) {
    throw new Error("parseCamt053: no BkToCstmrStmt/Stmt found — not a CAMT.053 file");
  }

  const rows: ParsedRow[] = [];
  const errors: ParseResult["errors"] = [];
  let rowIndex = 0;

  for (const stmt of stmtList) {
    // Stmt/Acct/Id/IBAN is the statement's own account. A statement without one
    // is still parsed — the rows just carry null and surface as "unknown account".
    const accountIban = normalizeAccount(
      text(path(asNode(stmt), "Acct", "Id", "IBAN")), "ABNA");

    const entries = (asNode(stmt)?.["Ntry"] ?? []) as unknown[];
    if (!Array.isArray(entries)) continue;

    for (const entryRaw of entries) {
      const entry = asNode(entryRaw);
      const raw = JSON.stringify(entryRaw);

      // Entry-level fields first: a failure here voids the whole Ntry (one error).
      let entryAmt: { value: string; ccy: string | null };
      let sign: number;
      let bookedAt: Date;
      let txDtls: XmlNode[];
      try {
        if (!entry) throw new Error("malformed Ntry");
        const amt = amount(entry["Amt"]);
        if (!amt) throw new Error("Ntry has no Amt");
        entryAmt = amt;
        const ind = text(entry["CdtDbtInd"]);
        if (ind !== "DBIT" && ind !== "CRDT") throw new Error(`unknown CdtDbtInd: ${ind}`);
        sign = ind === "DBIT" ? -1 : 1;
        const bookgDt = text(path(entry, "BookgDt", "Dt"));
        if (!bookgDt || !/^\d{4}-\d{2}-\d{2}$/.test(bookgDt)) {
          throw new Error(`missing or malformed BookgDt/Dt: ${bookgDt}`);
        }
        bookedAt = new Date(`${bookgDt}T00:00:00Z`);
        // Date parsing rolls out-of-range days over ("2026-02-31" → 2026-03-03);
        // reconstruct the ISO string to catch impossible calendar dates.
        if (Number.isNaN(bookedAt.getTime()) || bookedAt.toISOString().slice(0, 10) !== bookgDt) {
          throw new Error(`missing or malformed BookgDt/Dt: ${bookgDt}`);
        }

        const txDtlsList = path(entry, "NtryDtls", "TxDtls");
        txDtls = Array.isArray(txDtlsList)
          ? txDtlsList.map((t) => asNode(t) ?? {})
          : [{}]; // entry without details still yields one row from entry-level data
      } catch (err) {
        errors.push({
          rowIndex: rowIndex++,
          raw,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Per-TxDtls isolation: one bad transaction must not drop or hide its
      // siblings — each failed TxDtls gets its own errors[] entry and consumes
      // its own rowIndex, so the sequence stays contiguous.
      const batched = txDtls.length > 1;
      for (const tx of txDtls) {
        try {
          const txAmtDetail = amount(path(tx, "AmtDtls", "TxAmt", "Amt"));
          if (!txAmtDetail && batched) {
            // Falling back to the entry Amt per-TxDtls would multiply the
            // entry total by the batch size — refuse instead of fabricating.
            throw new Error(
              "batched TxDtls without AmtDtls/TxAmt — cannot attribute the entry amount"
            );
          }
          const txAmt = txAmtDetail ?? entryAmt;
          const ccy = txAmt.ccy ?? entryAmt.ccy;
          if (ccy !== "EUR") throw new Error(`unsupported currency: ${ccy ?? "unknown"} (only EUR)`);
          // Compute the amount before building the row object so a throw here
          // cannot burn a rowIndex via `rowIndex++` in an unassigned literal.
          const amountCents = sign * Math.abs(decimalToCents(txAmt.value));

          const pties = asNode(tx["RltdPties"]);
          const counterpartyName =
            sign < 0
              ? text(path(pties, "Cdtr", "Nm"))
              : text(path(pties, "Dbtr", "Nm"));
          const counterpartyIban =
            sign < 0
              ? text(path(pties, "CdtrAcct", "Id", "IBAN"))
              : text(path(pties, "DbtrAcct", "Id", "IBAN"));
          const mandateId = text(path(tx, "Refs", "MndtId"));
          const ustrd = path(tx, "RmtInf", "Ustrd");
          const description = Array.isArray(ustrd)
            ? ustrd.map((u) => text(u)).filter((u): u is string => u !== null).join(" ") || null
            : text(ustrd);

          rows.push({
            rowIndex: rowIndex++,
            bookedAt,
            amountCents,
            counterpartyName,
            counterpartyIban,
            description,
            mandateId,
            accountIban,
          });
        } catch (err) {
          errors.push({
            rowIndex: rowIndex++,
            raw,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return { rows, errors };
}
