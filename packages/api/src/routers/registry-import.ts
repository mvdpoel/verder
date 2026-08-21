import { readFile } from "node:fs/promises";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { schema } from "@verder/db";
import {
  detectSource, parseAbnSheet, parseAbnTsv, parseCamt053, parsePaypalCsv, sniffContainer,
  XLS_MIME, type ParseResult, type StatementSource,
} from "@verder/parsers";
import { protectedProcedure, router } from "../trpc";
import { readFilePath } from "../storage";
import { ingestDocument } from "./documents";

/**
 * Statement import, vault-first: the upload route stores the raw bytes in the
 * vault BEFORE anything else, then calls `ingest` with the sha256. Ingest
 * registers the file as evidence (document + ledger event) even when the
 * format turns out to be unrecognizable — bytes on record beat clean failures.
 *
 * No job is enqueued here: the worker's `registry.mine` cron (Task 7) sweeps
 * un-mined transactions every 2 minutes. Ingest only inserts rows,
 * idempotently on (statementSha256, rowIndex).
 */

const PARSERS: Record<StatementSource, (buf: Buffer) => ParseResult> = {
  "abn-camt053": parseCamt053,
  "abn-tsv": parseAbnTsv,
  "paypal-csv": parsePaypalCsv,
  "abn-xls": parseAbnSheet,
};

const FIXED_MIME: Record<Exclude<StatementSource, "abn-xls">, string> = {
  "abn-camt053": "application/xml",
  "abn-tsv": "text/tab-separated-values",
  "paypal-csv": "text/csv",
};

/**
 * abn-xls covers two containers, so its mime comes from the bytes rather than
 * the source: recording a genuine .xlsx as application/vnd.ms-excel would hand
 * the preview and the extractor a type that contradicts the file itself.
 */
function mimeFor(source: StatementSource, buf: Buffer): string {
  if (source !== "abn-xls") return FIXED_MIME[source];
  return sniffContainer(buf) ?? XLS_MIME;
}

export const registryImportRouter = router({
  ingest: protectedProcedure.input(z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    filename: z.string().min(1),
  })).mutation(async ({ ctx, input }) => {
    const vaultDir = process.env.VAULT_DIR ?? "./vault-files";
    let buf: Buffer;
    try {
      buf = await readFile(readFilePath(vaultDir, input.sha256));
    } catch {
      throw new TRPCError({ code: "NOT_FOUND",
        message: "File is not in the vault yet — upload it first" });
    }

    const source = detectSource(input.filename, buf);

    // Evidence first: register the document (idempotent by sha256, ledger
    // event in the same transaction) before judging the format.
    await ctx.db.transaction((tx) => ingestDocument(tx, {
      sha256: input.sha256, sizeBytes: buf.length,
      mime: source ? mimeFor(source, buf) : "application/octet-stream",
      title: input.filename, source: "upload",
      receivedAt: new Date(), docType: "bank-statement",
    }));

    if (!source) {
      throw new TRPCError({ code: "BAD_REQUEST",
        message: "Unrecognized statement format (expected ABN CAMT.053 XML, ABN TSV, ABN Excel, or PayPal CSV)" });
    }

    // A corrupt workbook throws where the text parsers never did. The document
    // is already registered above; turn the failure into a clear 400.
    let parsed: ParseResult;
    try {
      parsed = PARSERS[source](buf);
    } catch (err) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Could not read this ${source} file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    // A file the parser understood NOTHING of is the wrong kind of file, not a
    // statement full of broken lines. Detection can only tell a spreadsheet
    // from a Word document — a household budget workbook looks exactly like a
    // statement to it, and every row of one fails the ABN row contract. Left
    // to run, that writes one parse-error transaction per row into a table
    // with no DELETE grant: permanent junk evidence, and a phantom statement
    // in "Past imports" forever. The document stays registered above; only the
    // rows are refused.
    if (parsed.rows.length === 0 && parsed.errors.length > 0) {
      throw new TRPCError({ code: "BAD_REQUEST",
        message: `This ${source} file has no readable statement rows — ${parsed.errors.length} line${parsed.errors.length === 1 ? "" : "s"} could not be read. It is stored in the vault, but nothing was imported.` });
    }
    // Malformed rows are kept, never dropped: parseError + raw text.
    const values = [
      ...parsed.rows.map((r) => ({
        source, bookedAt: r.bookedAt, amountCents: r.amountCents,
        counterpartyName: r.counterpartyName, counterpartyIban: r.counterpartyIban,
        description: r.description, mandateId: r.mandateId,
        accountIban: r.accountIban,
        statementSha256: input.sha256, rowIndex: r.rowIndex,
      })),
      // Deliberately no accountIban on error rows: an unreadable row has no
      // trustworthy account, and null correctly puts it in the unknown-account
      // bucket rather than vouching for one.
      ...parsed.errors.map((e) => ({
        source, bookedAt: new Date(), amountCents: 0,
        statementSha256: input.sha256, rowIndex: e.rowIndex,
        parseError: true, rawRow: e.raw,
      })),
    ];
    let inserted = 0;
    if (values.length > 0) {
      const insertedRows = await ctx.db.insert(schema.transactions).values(values)
        .onConflictDoNothing({
          target: [schema.transactions.statementSha256, schema.transactions.rowIndex] })
        .returning({ id: schema.transactions.id });
      inserted = insertedRows.length;
    }
    return {
      statementSha256: input.sha256,
      inserted,
      skipped: values.length - inserted,
      errors: parsed.errors.length,
      source,
    };
  }),

  list: protectedProcedure.query(({ ctx }) =>
    ctx.db.select({
      statementSha256: schema.transactions.statementSha256,
      source: schema.transactions.source,
      total: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${schema.transactions.parseError})::int`,
      documentId: schema.documents.id,
      documentTitle: schema.documents.title,
      importedAt: schema.documents.createdAt,
    })
      .from(schema.transactions)
      .leftJoin(schema.documents,
        eq(schema.documents.sha256, schema.transactions.statementSha256))
      .groupBy(schema.transactions.statementSha256, schema.transactions.source,
        schema.documents.id, schema.documents.title, schema.documents.createdAt)
      .orderBy(desc(schema.documents.createdAt))),
});
