import { readFile } from "node:fs/promises";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { schema } from "@verder/db";
import {
  detectSource, parseAbnTsv, parseCamt053, parsePaypalCsv,
  type ParseResult, type StatementSource,
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
};

const MIME: Record<StatementSource, string> = {
  "abn-camt053": "application/xml",
  "abn-tsv": "text/tab-separated-values",
  "paypal-csv": "text/csv",
};

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

    const source = detectSource(input.filename, buf.subarray(0, 1024));

    // Evidence first: register the document (idempotent by sha256, ledger
    // event in the same transaction) before judging the format.
    await ctx.db.transaction((tx) => ingestDocument(tx, {
      sha256: input.sha256, sizeBytes: buf.length,
      mime: source ? MIME[source] : "application/octet-stream",
      title: input.filename, source: "upload",
      receivedAt: new Date(), docType: "bank-statement",
    }));

    if (!source) {
      throw new TRPCError({ code: "BAD_REQUEST",
        message: "Unrecognized statement format (expected ABN CAMT.053 XML, ABN TSV, or PayPal CSV)" });
    }

    const parsed = PARSERS[source](buf);
    // Malformed rows are kept, never dropped: parseError + raw text.
    const values = [
      ...parsed.rows.map((r) => ({
        source, bookedAt: r.bookedAt, amountCents: r.amountCents,
        counterpartyName: r.counterpartyName, counterpartyIban: r.counterpartyIban,
        description: r.description, mandateId: r.mandateId,
        statementSha256: input.sha256, rowIndex: r.rowIndex,
      })),
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
