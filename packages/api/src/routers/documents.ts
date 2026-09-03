import { access, readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { effectiveMime, isSpreadsheetMime, readWorkbook, type SheetData } from "@verder/parsers";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";
import {
  docTypeKeySql, effectiveDocStatusSql, effectiveDocTypeSql, effectivePartyIdSql,
  effectiveTitleSql, notDiscardedSql, notPurgedSql, purgedSql, receivedMonthSql,
} from "../effective-status";
import { bundleWhere } from "./bundles";
import { docTypeLabel } from "../doc-type";
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
  // EVERY change row, newest first — not just the newest two. The second row
  // is still what "Undo discard" has to restore (undoing always to "inbox"
  // would silently unfile a filed document discarded by mistake), but title,
  // soort and sender each need the newest row that HAS AN OPINION about them,
  // which can sit arbitrarily far back. A document accumulates one row per
  // correction Martin makes, so this is a handful of rows, not a table scan.
  const changes = await db.select().from(schema.documentStatusChanges)
    .where(eq(schema.documentStatusChanges.documentId, id))
    .orderBy(desc(schema.documentStatusChanges.createdAt));
  const [purged] = await db.select().from(schema.documentPurges)
    .where(eq(schema.documentPurges.documentId, id));
  const latest = changes[0];
  /**
   * THE SAME RESOLUTION effectiveTitleSql / effectiveDocTypeSql /
   * effectivePartyIdSql do in SQL: the newest change row that NAMES the field,
   * never simply the newest row.
   *
   * Reading `latest?.field ?? doc.field` disagreed with the SQL the moment a
   * later row was silent about a field an earlier row had filled — which the
   * UI produces in one action, because clearing the Soort box sends
   * `undefined` and that column lands NULL. FilesTable renders the SQL answer
   * and FilesPreview the JS one, side by side in the same request, so the two
   * spellings must not drift.
   */
  const newest = <T>(pick: (c: typeof changes[number]) => T | null | undefined): T | null => {
    for (const c of changes) {
      const v = pick(c);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  return { ...doc,
    // Status is the exception: document_status_changes.status is NOT NULL, so
    // every row has an opinion and the newest row simply wins.
    effectiveStatus: latest?.status ?? doc.status,
    effectiveTitle: newest((c) => c.title) ?? doc.title,
    effectiveDocType: newest((c) => c.docType) ?? doc.docType,
    // Which is why a sender can be overwritten but never cleared: a change row
    // with a null party reads as "no opinion", not as "cleared". Documented,
    // tested, and deliberate — see the "cannot clear a sender" test.
    effectivePartyId: newest((c) => c.partyId) ?? doc.partyId ?? null,
    previousStatus: changes[1]?.status ?? doc.status,
    /**
     * The tombstone, or null. `bytesStillOnDisk` is a live `access` check, not
     * a stored flag: the unlink runs after the transaction commits (see the
     * purge mutation), so a crash or an EACCES between the two leaves a purge
     * record whose bytes are still there. Storing "we deleted it" would record
     * an intention as a fact; asking the filesystem records what is true.
     */
    purge: purged ? {
      at: purged.createdAt, reason: purged.reason,
      sha256: purged.sha256, sizeBytes: purged.sizeBytes,
      bytesStillOnDisk: await access(
        readFilePath(process.env.VAULT_DIR ?? "./vault-files", purged.sha256),
      ).then(() => true, () => false),
    } : null };
}

/** Enough to see what a statement is; far short of hanging the tab on a big one. */
export const SHEET_PREVIEW_MAX_ROWS = 200;

/**
 * The middle pane's branch selector. Exported for the web layer to import.
 *
 * The URL layer additionally has a `bundels` (plural) kind that lists bundles
 * themselves rather than filtering documents into one — a VIEW, not a
 * filter — and it deliberately does not appear here.
 */
export const branchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("alles") }),
  z.object({ kind: z.literal("bundel"), id: z.string().uuid() }),
  z.object({ kind: z.literal("soort"), key: z.string() }),
  z.object({ kind: z.literal("party"), id: z.string().uuid().nullable() }),
  z.object({ kind: z.literal("periode"), month: z.string().regex(/^\d{4}-\d{2}$/) }),
  z.object({ kind: z.literal("bron"), source: z.enum(["upload", "nas-scan", "email-attachment"]) }),
  z.object({ kind: z.literal("status"), status: z.enum(["inbox", "filed", "discarded"]) }),
]);

/**
 * The canonical payload a document.purged event carries. Exported because
 * verification.ts recomputes it from the live document_purges row — editing a
 * stored reason must surface as a payload_hash_mismatch, the same discipline
 * registryDecisionPayload and taskStatusPayload already follow.
 */
export function documentPurgePayload(p: {
  documentId: string; sha256: string; sizeBytes: number; reason: string | null;
}) {
  return { id: p.documentId, sha256: p.sha256, sizeBytes: p.sizeBytes,
    reason: p.reason };
}

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

  /**
   * The left pane, as counts.
   *
   * Every number comes from a grouped query against the database and never from
   * measuring the page that was just rendered — the rule `counts` established
   * when "Postvak — 100 te sorteren" was what a vault of 100 and a vault of
   * 1000 both said.
   *
   * Discarded documents are excluded from every branch except `status`, which
   * is the branch that exists to find them again.
   */
  tree: protectedProcedure.query(async ({ ctx }) => {
    const live = notDiscardedSql;
    // docTypeKeySql and receivedMonthSql are the module-level constants
    // `browse`'s soort/periode branches filter on too — see their doc
    // comments for why grouping on the raw columns would disagree with the
    // effective document, and with browse's row query.
    const month = receivedMonthSql;

    const [soortRows, vanWieRows, periodeRows, bronRows, statusRows] = await Promise.all([
      ctx.db.select({
        // The raw spellings come back as an array, one entry PER ROW — no
        // DISTINCT — so docTypeLabel can count occurrences and pick the
        // spelling most rows actually use. De-duplicating here would make
        // every spelling appear exactly once, turning the majority vote into
        // an alphabetical tie-break regardless of how skewed the real data is.
        key: docTypeKeySql,
        spellings: sql<string[]>`array_agg(btrim(coalesce(${effectiveDocTypeSql},'')))`,
        n: sql<number>`count(*)::int`,
      }).from(schema.documents).where(live)
        .groupBy(docTypeKeySql),

      // A LEFT JOIN, not a correlated name subquery: nesting
      // effectivePartyIdSql a second time inside a `(SELECT p.name FROM
      // parties p WHERE p.id = (...))` subquery pushes its inner
      // documents.id reference one query level deeper than the GROUP BY
      // expression it would otherwise match, and Postgres refuses it —
      // "subquery uses ungrouped column documents.id from outer query"
      // (measured). Joining on parties.id and grouping by it too lets
      // Postgres select parties.name ungrouped via its functional-dependency
      // rule for a joined table's primary key.
      ctx.db.select({
        // Same reasoning as docTypeKeySql: a sender correction lives in
        // document_status_changes and is never written back to
        // documents.party_id.
        partyId: effectivePartyIdSql,
        name: schema.parties.name,
        n: sql<number>`count(*)::int`,
      }).from(schema.documents)
        .leftJoin(schema.parties, eq(effectivePartyIdSql, schema.parties.id))
        .where(live)
        .groupBy(effectivePartyIdSql, schema.parties.id),

      ctx.db.select({ month, n: sql<number>`count(*)::int` })
        .from(schema.documents).where(live).groupBy(month)
        .orderBy(sql`${month} desc`),

      ctx.db.select({ source: schema.documents.source, n: sql<number>`count(*)::int` })
        .from(schema.documents).where(live).groupBy(schema.documents.source),

      ctx.db.select({ status: effectiveDocStatusSql, n: sql<number>`count(*)::int` })
        .from(schema.documents).groupBy(effectiveDocStatusSql),
    ]);

    const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli",
      "augustus", "september", "oktober", "november", "december"];

    return {
      soort: soortRows
        .map((r) => ({ key: r.key, label: docTypeLabel(r.spellings ?? []), n: r.n }))
        // Biggest first, but "Zonder soort" (the empty key) always last: it is
        // a to-do list, not a category, and it is often the largest branch.
        .sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : b.n - a.n)),
      vanWie: vanWieRows
        .map((r) => ({ partyId: r.partyId, name: r.name ?? "Onbekend", n: r.n }))
        .sort((a, b) => (a.partyId === null ? 1 : b.partyId === null ? -1 : b.n - a.n)),
      periode: periodeRows.map((r) => ({
        month: r.month,
        label: `${MONTHS[Number(r.month.slice(5, 7)) - 1]} ${r.month.slice(2, 4)}`,
        n: r.n,
      })),
      bron: bronRows,
      status: statusRows,
    };
  }),

  /**
   * The middle pane: the rows for whichever branch is selected, sorted,
   * capped, with a true total.
   *
   * THE INVARIANT: every branch filter below reuses the EXACT expression
   * `tree` grouped on (docTypeKeySql, effectivePartyIdSql, receivedMonthSql,
   * effectiveDocStatusSql) — never a lookalike restated by hand. A filter
   * that drifts from its grouping by so much as a fold would show a
   * different set than the count `tree` promised, on the same screen, which
   * is the one thing this page may not do.
   */
  browse: protectedProcedure.input(z.object({
    branch: branchSchema.default({ kind: "alles" }),
    sort: z.enum(["naam", "soort", "van", "datum", "grootte"]).default("datum"),
    dir: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(200).default(100),
  })).query(async ({ ctx, input }) => {
    const b = input.branch;
    // Every branch but `status` and `bundel` hides discarded documents.
    // `status` is the one that exists to find them again, so it filters on the
    // effective status instead of excluding by it — and a `bundel` lets its
    // own membership decide, see bundleWhere.
    const where =
      // A bundle resolves its own membership, because the two kinds do not
      // resolve alike: a rule bundle holds no rows in bundle_documents at all,
      // so the IN-subquery this used to spell by hand showed an empty table
      // under a tree count of 12 and a card that downloaded 12 files.
      b.kind === "bundel" ? await bundleWhere(ctx.db, b.id)
      : b.kind === "status" ? sql`${effectiveDocStatusSql} = ${b.status}`
      : b.kind === "soort" ? sql`${notDiscardedSql} AND ${docTypeKeySql} = ${b.key}`
      : b.kind === "party" ? (b.id === null
          ? sql`${notDiscardedSql} AND ${effectivePartyIdSql} IS NULL`
          : sql`${notDiscardedSql} AND ${effectivePartyIdSql} = ${b.id}`)
      : b.kind === "periode" ? sql`${notDiscardedSql} AND ${receivedMonthSql} = ${b.month}`
      : b.kind === "bron" ? sql`${notDiscardedSql} AND documents.source = ${b.source}`
      : notDiscardedSql; // "alles"

    // Sort by the sender's NAME, resolved through the same effective party id
    // the row and the `party` branch use — sorting on the raw column would
    // order a corrected sender by where they used to be filed.
    const partyNameSql = sql<string | null>`(SELECT p.name FROM parties p
      WHERE p.id = ${effectivePartyIdSql})`;
    const orderExpr =
      input.sort === "naam" ? effectiveTitleSql
      : input.sort === "soort" ? docTypeKeySql
      : input.sort === "van" ? partyNameSql
      : input.sort === "grootte" ? schema.documents.sizeBytes
      : schema.documents.receivedAt; // "datum"

    const [rows, [count]] = await Promise.all([
      ctx.db.select({
        id: schema.documents.id,
        // Resolved through the newest change row that HAS an opinion — what
        // effectiveDocument does per document, done in SQL here because doing
        // it per row would be a round trip per document.
        title: effectiveTitleSql,
        docType: effectiveDocTypeSql,
        partyId: effectivePartyIdSql,
        partyName: partyNameSql,
        receivedAt: schema.documents.receivedAt,
        sizeBytes: schema.documents.sizeBytes,
        mime: schema.documents.mime,
        sha256: schema.documents.sha256,
        source: schema.documents.source,
        status: effectiveDocStatusSql,
      }).from(schema.documents).where(where)
        .orderBy(input.dir === "asc" ? asc(orderExpr) : desc(orderExpr))
        .limit(input.limit),
      // The TRUE total, counted in the database. Measuring `rows.length`
      // would make a capped page indistinguishable from a complete one —
      // the one thing this page may never do.
      ctx.db.select({ n: sql<number>`count(*)::int` })
        .from(schema.documents).where(where),
    ]);
    return { rows, total: count.n };
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
        // An ABSENT field is not a field set back to its ingest value: it is a
        // row that says nothing, and effectiveDocument resolves such a row by
        // keeping whatever the newest row WITH an opinion said. So an absent
        // field changes nothing by definition, and only a field that is both
        // present and different makes this a real edit.
        //
        // Comparing an absent title against `doc.title` (as this did) broke
        // the no-op law for a RENAMED document: discarding "Huurcontract
        // 2026" a second time compared its effective title against the
        // ingest-time "scan_002", found them different, and appended a second
        // discard the record would then claim Martin made.
        const same = <T>(given: T | undefined, effective: T) =>
          given === undefined || given === effective;
        if (current.effectiveStatus === input.status
          && same(input.title, current.effectiveTitle)
          && same(input.docType, current.effectiveDocType)
          && same(input.partyId, current.effectivePartyId)) return current;
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

  /**
   * Definitief verwijderen: destroy a document's CONTENT and record that we did.
   *
   * What is destroyed: the vault file, the extracted text, the search chunks.
   * What survives: the `documents` row (it anchors the document.ingested event,
   * which can never leave the hash chain) and every ledgered citation —
   * entry_documents, debt_documents, registry_decisions, stops, tasks. Removing
   * an entry_documents row would change that ENTRY's recomputed payload hash,
   * because entryEventPayload carries documentIds, and read as tampering with
   * the logbook.
   *
   * Irreversible, and doubly so: documents.sha256 is UNIQUE and ingestDocument
   * dedups on it, so those bytes can never re-enter the vault. That is the rule
   * discard already carries ("a discarded document stays discarded for those
   * bytes forever"), applied to a stronger action.
   */
  purge: protectedProcedure.input(z.object({
    id: z.string().uuid(), reason: z.string().trim().min(1).optional(),
  })).mutation(async ({ ctx, input }) => {
    const vaultDir = process.env.VAULT_DIR ?? "./vault-files";
    const sha = await ctx.db.transaction(async (tx) => {
      // The same per-document serialisation `update` uses: two clicks landing
      // together would otherwise both find no purge row and both insert, and
      // the UNIQUE constraint would turn the loser into a 500.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.id}::text, 0))`);
      const [doc] = await tx.select().from(schema.documents)
        .where(eq(schema.documents.id, input.id));
      if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
      const [already] = await tx.select().from(schema.documentPurges)
        .where(eq(schema.documentPurges.documentId, input.id));
      // A no-op, not an error: one decision must not appear in the record
      // twice, and the button is one click Martin can land twice. The FIRST
      // reason stands — a second call may not rewrite the record. It still
      // falls through to the unlink below, which is the repair path for a
      // purge whose bytes survived the first attempt.
      if (already) return already.sha256;
      await tx.insert(schema.documentPurges).values({
        documentId: doc.id, sha256: doc.sha256, sizeBytes: doc.sizeBytes,
        reason: input.reason ?? null, createdBy: ctx.userId });
      await appendLedgerEvent(tx, {
        eventType: "document.purged", entityType: "document", entityId: doc.id,
        payload: documentPurgePayload({ documentId: doc.id, sha256: doc.sha256,
          sizeBytes: doc.sizeBytes, reason: input.reason ?? null }) });
      // The derived layer, destroyed in the same transaction as the record.
      // These are the two tables that hold the document's CONTENT outside the
      // vault: without this the button is a lie, and `reindex` would rebuild
      // the chunk from the text on its next run.
      await tx.delete(schema.documentTexts)
        .where(eq(schema.documentTexts.documentId, doc.id));
      await tx.delete(schema.searchChunks)
        .where(and(eq(schema.searchChunks.entityType, "document"),
          eq(schema.searchChunks.entityId, doc.id)));
      return doc.sha256;
    });
    /*
     * THE UNLINK IS AFTER THE COMMIT AND THAT ORDERING IS NOT INTERCHANGEABLE.
     * unlink is not transactional. Inside the transaction, a rollback after a
     * successful unlink destroys the bytes with NO RECORD of it — permanently
     * red on /verify with nothing explaining why, which is the one outcome
     * this whole design exists to prevent. After the commit, the failure mode
     * is the harmless one: a purge record whose bytes are still on disk, which
     * effectiveDocument reports as bytesStillOnDisk, /verify counts, and a
     * second click repairs.
     *
     * ENOENT is success, not an error: the file is gone, which is the goal.
     */
    await unlink(readFilePath(vaultDir, sha)).catch(() => {});
    return effectiveDocument(ctx.db, input.id);
  }),

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
