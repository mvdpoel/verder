import { readFile } from "node:fs/promises";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { effectiveMime, isSpreadsheetMime, readWorkbook, type SheetData } from "@verder/parsers";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";
import { readFilePath, relPathFor } from "../storage";

export async function ingestDocument(tx: Db, input: {
  sha256: string; sizeBytes: number; mime: string; title: string;
  source: "upload" | "nas-scan" | "email-attachment"; sourceRef?: string;
  receivedAt: Date; docType?: string;
}) {
  const [existing] = await tx.select().from(schema.documents)
    .where(eq(schema.documents.sha256, input.sha256));
  if (existing) return existing;
  const [doc] = await tx.insert(schema.documents).values(input).returning();
  await appendLedgerEvent(tx, {
    eventType: "document.ingested", entityType: "document", entityId: doc.id,
    payload: { id: doc.id, sha256: doc.sha256, title: doc.title,
      docType: doc.docType ?? null, mime: doc.mime, sizeBytes: doc.sizeBytes,
      source: doc.source, sourceRef: doc.sourceRef ?? null,
      receivedAt: input.receivedAt.toISOString() },
  });
  return doc;
}

export async function effectiveDocument(db: Db, id: string) {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
  if (!doc) throw new Error("Document not found");
  const [latest] = await db.select().from(schema.documentStatusChanges)
    .where(eq(schema.documentStatusChanges.documentId, id))
    .orderBy(desc(schema.documentStatusChanges.createdAt)).limit(1);
  return { ...doc,
    effectiveStatus: latest?.status ?? doc.status,
    effectiveTitle: latest?.title ?? doc.title,
    effectiveDocType: latest?.docType ?? doc.docType };
}

/** Enough to see what a statement is; far short of hanging the tab on a big one. */
export const SHEET_PREVIEW_MAX_ROWS = 200;

export const documentsRouter = router({
  registerUpload: protectedProcedure.input(z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/), sizeBytes: z.number().int().positive(),
    mime: z.string(), title: z.string().min(1),
    source: z.enum(["upload", "nas-scan", "email-attachment"]),
    sourceRef: z.string().optional(), receivedAt: z.coerce.date(),
    docType: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction((tx) => ingestDocument(tx, input))),

  list: protectedProcedure.input(z.object({
    status: z.enum(["inbox", "filed"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(schema.documents)
      .orderBy(desc(schema.documents.createdAt)).limit(input.limit);
    const effective = await Promise.all(rows.map((r) => effectiveDocument(ctx.db, r.id)));
    return input.status ? effective.filter((d) => d.effectiveStatus === input.status) : effective;
  }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => effectiveDocument(ctx.db, input.id)),

  bySha: protectedProcedure.input(z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
    .query(async ({ ctx, input }) => {
      const [doc] = await ctx.db.select().from(schema.documents)
        .where(eq(schema.documents.sha256, input.sha256));
      if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
      return effectiveDocument(ctx.db, doc.id);
    }),

  sheetPreview: protectedProcedure.input(z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    maxRows: z.number().int().min(1).max(1000).default(SHEET_PREVIEW_MAX_ROWS),
  })).query(async ({ ctx, input }) => {
    const [doc] = await ctx.db.select().from(schema.documents)
      .where(eq(schema.documents.sha256, input.sha256));
    if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });

    let buf: Buffer;
    try {
      buf = await readFile(
        readFilePath(process.env.VAULT_DIR ?? "./vault-files", input.sha256));
    } catch {
      // A row whose bytes are missing is an orphan, not a server fault: the
      // ingest path calls that a 404, and so does this.
      throw new TRPCError({ code: "NOT_FOUND", message: "File is not in the vault" });
    }
    // The stored mime is whatever the source claimed — ABN's export arrives as
    // octet-stream — so fall back to the bytes, exactly as extraction does.
    if (!isSpreadsheetMime(effectiveMime(doc.mime, buf))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Document is not a spreadsheet" });
    }

    let sheets: SheetData[];
    try {
      // One row past the cap: enough to know the sheet continues, and the cap
      // is handed to the READER so it bounds the parse itself. Slicing after a
      // full parse would leave a hostile workbook free to stall the server —
      // XLSX.read is synchronous, so its cost is every request's cost.
      sheets = readWorkbook(buf, { maxRows: input.maxRows + 1 });
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST",
        message: `Could not read this workbook: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (sheets.length === 0) {
      return { sheetName: "", rows: [], totalSheets: 0, truncated: false };
    }
    const first = sheets[0];
    return {
      sheetName: first.name,
      rows: first.rows.slice(0, input.maxRows),
      totalSheets: sheets.length,
      // No true total: knowing it would mean parsing the whole workbook, which
      // is exactly the work the cap exists to refuse.
      truncated: first.rows.length > input.maxRows,
    };
  }),

  file: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const doc = await effectiveDocument(ctx.db, input.id);
      return { ...doc, relPath: relPathFor(doc.sha256) };
    }),

  update: protectedProcedure.input(z.object({
    id: z.string().uuid(), status: z.enum(["inbox", "filed"]),
    title: z.string().optional(), docType: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      await tx.insert(schema.documentStatusChanges).values({
        documentId: input.id, status: input.status,
        title: input.title, docType: input.docType });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: input.id,
        payload: { id: input.id, status: input.status,
          title: input.title ?? null, docType: input.docType ?? null } });
      return effectiveDocument(tx, input.id);
    })),

  linkToEntry: protectedProcedure.input(z.object({
    documentId: z.string().uuid(), entryId: z.string().uuid(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      await tx.insert(schema.entryDocuments)
        .values({ entryId: input.entryId, documentId: input.documentId });
      await appendLedgerEvent(tx, {
        eventType: "document.linked", entityType: "document", entityId: input.documentId,
        payload: { documentId: input.documentId, entryId: input.entryId } });
    })),
});
