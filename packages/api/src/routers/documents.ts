import { readFile } from "node:fs/promises";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { effectiveMime, isSpreadsheetMime, readWorkbook, type SheetData } from "@verder/parsers";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";
import { effectiveDocStatusSql, notDiscardedSql } from "../effective-status";
import { readFilePath, relPathFor } from "../storage";

export async function ingestDocument(tx: Db, input: {
  sha256: string; sizeBytes: number; mime: string; title: string;
  source: "upload" | "nas-scan" | "email-attachment"; sourceRef?: string;
  receivedAt: Date; docType?: string; partyId?: string;
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
      receivedAt: input.receivedAt.toISOString(), partyId: doc.partyId ?? null },
  });
  return doc;
}

export async function effectiveDocument(db: Db, id: string) {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
  // NOT_FOUND rather than a bare Error: the web app turns this one code into
  // a 404 page (`orNotFound`), and every other router already speaks it.
  // A bare Error is indistinguishable from a crash and renders as one.
  if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
  // Two rows, not one: the second is what the latest change replaced, which is
  // what "Undo discard" has to restore. Undoing always to "inbox" would
  // silently unfile a filed document discarded by mistake.
  const changes = await db.select().from(schema.documentStatusChanges)
    .where(eq(schema.documentStatusChanges.documentId, id))
    .orderBy(desc(schema.documentStatusChanges.createdAt)).limit(2);
  const latest = changes[0];
  return { ...doc,
    effectiveStatus: latest?.status ?? doc.status,
    effectiveTitle: latest?.title ?? doc.title,
    effectiveDocType: latest?.docType ?? doc.docType,
    // ?? and not ||: a change row that says nothing about the sender leaves
    // the ingest-time value standing. See the "cannot clear" test.
    effectivePartyId: latest?.partyId ?? doc.partyId ?? null,
    previousStatus: changes[1]?.status ?? doc.status };
}

/** Enough to see what a statement is; far short of hanging the tab on a big one. */
export const SHEET_PREVIEW_MAX_ROWS = 200;

export const documentsRouter = router({
  registerUpload: protectedProcedure.input(z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/), sizeBytes: z.number().int().positive(),
    mime: z.string(), title: z.string().min(1),
    source: z.enum(["upload", "nas-scan", "email-attachment"]),
    sourceRef: z.string().optional(), receivedAt: z.coerce.date(),
    docType: z.string().optional(), partyId: z.string().uuid().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction((tx) => ingestDocument(tx, input))),

  list: protectedProcedure.input(z.object({
    status: z.enum(["inbox", "filed", "discarded"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    // Discarded documents stay reachable by direct URL and by asking for them
    // here; they are only kept out of the surfaces Martin scans.
    includeDiscarded: z.boolean().default(false),
  })).query(async ({ ctx, input }) => {
    // Filtered in SQL, BEFORE the limit. Filtering afterwards would let
    // discarded documents eat the page budget: the evidence pickers ask for
    // 100 and would be handed 91, with nine real documents pushed off the end
    // and no indication the list was truncated.
    //
    // The EFFECTIVE status, resolved the same way effectiveDocument does it —
    // a discard is appended to document_status_changes and never written back,
    // so documents.status keeps reading "inbox" forever. Cast to text so the
    // comparison does not depend on the enum's own operator set.
    const where = input.status
      ? sql`${effectiveDocStatusSql} = ${input.status}`
      // IS DISTINCT FROM, not <>, for the same reason it is used in search.
      : input.includeDiscarded ? undefined : notDiscardedSql;
    const rows = await ctx.db.select().from(schema.documents).where(where)
      .orderBy(desc(schema.documents.createdAt)).limit(input.limit);
    return Promise.all(rows.map((r) => effectiveDocument(ctx.db, r.id)));
  }),

  /**
   * How many documents there are per effective status — ALL of them, not a page.
   *
   * `list` is capped (the pickers ask for a page and must not be handed the
   * whole vault), so counting its rows under-reports the moment the vault
   * outgrows the cap: the vault page's own heading read "37 to sort" whether
   * there were 37 or 370. A count is one grouped query and cannot drift from
   * the list, because both resolve status the same way.
   */
  counts: protectedProcedure.query(async ({ ctx }) => {
    // The SAME effective-status expression `list` uses: a discard is appended
    // to document_status_changes and never written back, so documents.status
    // keeps reading "inbox" forever and counting the raw column would put every
    // discarded file back in the inbox tally.
    const status = effectiveDocStatusSql;
    const rows = await ctx.db
      .select({ status, n: sql<number>`count(*)::int` })
      .from(schema.documents)
      .groupBy(status);
    const by = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return { inbox: by("inbox"), filed: by("filed"), discarded: by("discarded") };
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
    id: z.string().uuid(), status: z.enum(["inbox", "filed", "discarded"]),
    title: z.string().optional(), docType: z.string().optional(),
    partyId: z.string().uuid().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      // A transition that would change nothing observable appends nothing.
      // Spec: discarding an already-discarded document is a no-op, not an
      // error — and the Discard button is one click Martin can land twice. The
      // append-only record is here to say what he did; two rows for one
      // decision would have it claim he discarded the same document twice.
      // A real edit (same status, new title) is NOT swallowed: the comparison
      // is against what appending would actually produce.
      // Serialize writers per document, so the check below is not a TOCTOU:
      // two clicks landing together (or a click racing the backfill) would
      // otherwise both read the old status and both append.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.id}::text, 0))`);
      const [doc] = await tx.select().from(schema.documents)
        .where(eq(schema.documents.id, input.id));
      if (doc) {
        const current = await effectiveDocument(tx, input.id);
        if (current.effectiveStatus === input.status
          && current.effectiveTitle === (input.title ?? doc.title)
          && current.effectiveDocType === (input.docType ?? doc.docType)
          && current.effectivePartyId === (input.partyId ?? current.effectivePartyId)) return current;
      }
      await tx.insert(schema.documentStatusChanges).values({
        documentId: input.id, status: input.status,
        title: input.title, docType: input.docType, partyId: input.partyId });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: input.id,
        payload: { id: input.id, status: input.status,
          title: input.title ?? null, docType: input.docType ?? null,
          partyId: input.partyId ?? null } });
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
