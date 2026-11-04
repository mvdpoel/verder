import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { APP_ACTOR, schema, type Db } from "@grip/db";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";
import { documentStatusChangePayloadWithParty } from "../verification";
import { effectiveDocument } from "./documents";

/**
 * "Door Grip gedaan" (spec §6.6, Plan 3 Task 15): every change Grip made
 * to a document on its own, and the one-tap undo of it.
 *
 * THE SOURCE IS THE LEDGERED CHANGE TABLE, never the suggestion: a
 * `document_status_changes` row with `actor = 'verder'` (migration 0040) is
 * what Grip did, hashed in its own payload shape. The suggestion is only the
 * learning signal beside it.
 *
 * TWO KINDS, told apart by one column: an auto-file applies a document-meta
 * suggestion and names it (`suggestion_id` set); an auto-name applies none
 * (`suggestion_id` NULL). `gripActionKind` is the one spelling of that rule,
 * and the 19:00 digest counts through it too.
 *
 * UNDO IS AN APPEND, never a delete or an update: a Martin row (actor NULL)
 * restoring the state before Grip's change, with its `document.updated`
 * event in the wide shape — exactly what documents.update would append had he
 * typed the old values back himself.
 */

export type GripActionKind = "auto-file" | "auto-name";

export function gripActionKind(c: { suggestionId: string | null }): GripActionKind {
  return c.suggestionId !== null ? "auto-file" : "auto-name";
}

export interface DocState { status: string; title: string | null; docType: string | null }

/**
 * The state a document has after `rows` (oldest first) are applied to its
 * ingest-time values, by the SAME newest-opinion rule as effectiveDocument:
 * status from the newest row (that column is NOT NULL), title and soort from
 * the newest row that names them. Pure, so "before" and "after" are computed
 * from one resolver and never from two that could drift.
 */
export function stateAfter(base: DocState, rows: readonly DocState[]): DocState {
  let { status, title, docType } = base;
  for (const r of rows) {
    status = r.status;
    if (r.title !== null) title = r.title;
    if (r.docType !== null) docType = r.docType;
  }
  return { status, title, docType };
}

type ChangeRow = typeof schema.documentStatusChanges.$inferSelect;

/**
 * A change counts as NEWER than `c` when it is a different row created at the
 * same instant or later. Equal timestamps (two rows in one transaction) count
 * as newer on purpose: an undo that refuses on a tie costs Martin a second
 * look; one that proceeds may overwrite a change he made.
 */
function isNewer(other: ChangeRow, c: ChangeRow): boolean {
  return other.id !== c.id && other.createdAt.getTime() >= c.createdAt.getTime();
}

export type NotUndoableReason = "al aangepast" | "vernietigd" | "naam staat ook op de NAS";

/**
 * Why this change cannot be undone, or null. One order, used by the list and
 * by the mutation, so the button and the refusal always name the same reason.
 *
 * AN AUTO-NAME IS NEVER UNDOABLE HERE: auto-name also renames the file on the
 * NAS share (auto-name.ts), and nas-known.ts matches share files against the
 * EFFECTIVE title, so a database-only undo would leave the share and the
 * dossier disagreeing about the file's name. The web container does not mount
 * the share. Reversing a name stays `pnpm --filter worker normalize-names --undo`.
 *
 * A PURGE writes no change row, so the newer-row check alone would let an undo
 * append `inbox` onto destroyed content.
 */
export function notUndoableReason(input: {
  kind: GripActionKind; purged: boolean; newerExists: boolean;
}): NotUndoableReason | null {
  if (input.kind === "auto-name") return "naam staat ook op de NAS";
  if (input.purged) return "vernietigd";
  if (input.newerExists) return "al aangepast";
  return null;
}

export interface GripActionDTO {
  changeId: string;
  documentId: string;
  /** The document's CURRENT effective title. */
  documentTitle: string | null;
  at: string;
  kind: GripActionKind;
  before: DocState;
  after: DocState;
  /** The title docmeta proposed; information only — auto-file never applies it. */
  proposedTitle: string | null;
  undone: boolean;
  undoable: boolean;
  notUndoableReason: NotUndoableReason | null;
}

/** The suggestion's record of an undo (the learning signal; the ledger row is the record). */
type UndoMark = { at: string; changeId: string; undoChangeId: string };

function undoMark(finalPayload: unknown): UndoMark | null {
  const u = (finalPayload as { undo?: unknown } | null)?.undo as Partial<UndoMark> | undefined;
  return u && typeof u.changeId === "string" ? u as UndoMark : null;
}

const LIST_LIMIT = 200;

export async function listGripActions(db: Db, sinceDays: number, now = new Date()): Promise<GripActionDTO[]> {
  const since = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);
  const c = schema.documentStatusChanges;
  const actions = await db.select().from(c)
    .where(and(eq(c.actor, APP_ACTOR), gte(c.createdAt, since)))
    .orderBy(desc(c.createdAt), desc(c.id)).limit(LIST_LIMIT);
  if (actions.length === 0) return [];

  const docIds = [...new Set(actions.map((a) => a.documentId))];
  const suggestionIds = [...new Set(actions.flatMap((a) => a.suggestionId ? [a.suggestionId] : []))];
  const [docs, changes, purges, suggestions] = await Promise.all([
    db.select({ id: schema.documents.id, status: schema.documents.status,
      title: schema.documents.title, docType: schema.documents.docType })
      .from(schema.documents).where(inArray(schema.documents.id, docIds)),
    db.select().from(c).where(inArray(c.documentId, docIds))
      .orderBy(asc(c.createdAt), asc(c.id)),
    db.select({ documentId: schema.documentPurges.documentId }).from(schema.documentPurges)
      .where(inArray(schema.documentPurges.documentId, docIds)),
    suggestionIds.length === 0 ? Promise.resolve([]) :
      db.select({ id: schema.suggestions.id, proposed: schema.suggestions.proposed,
        finalPayload: schema.suggestions.finalPayload })
        .from(schema.suggestions).where(inArray(schema.suggestions.id, suggestionIds)),
  ]);
  const docById = new Map(docs.map((d) => [d.id, d]));
  const purged = new Set(purges.map((p) => p.documentId));
  const suggestionById = new Map(suggestions.map((s) => [s.id, s]));
  const changesByDoc = new Map<string, ChangeRow[]>();
  for (const row of changes) {
    const list = changesByDoc.get(row.documentId) ?? [];
    list.push(row);
    changesByDoc.set(row.documentId, list);
  }

  return actions.flatMap((a): GripActionDTO[] => {
    const doc = docById.get(a.documentId);
    if (!doc) return [];
    const base: DocState = { status: doc.status, title: doc.title, docType: doc.docType };
    const rows = changesByDoc.get(a.documentId) ?? [];
    const older = rows.filter((r) => r.id !== a.id && !isNewer(r, a));
    const kind = gripActionKind(a);
    const reason = notUndoableReason({ kind, purged: purged.has(a.documentId),
      newerExists: rows.some((r) => isNewer(r, a)) });
    const s = a.suggestionId ? suggestionById.get(a.suggestionId) : undefined;
    const proposedTitle = (s?.proposed as { title?: unknown } | null)?.title;
    return [{
      changeId: a.id, documentId: a.documentId,
      documentTitle: stateAfter(base, rows).title,
      at: a.createdAt.toISOString(), kind,
      before: stateAfter(base, older),
      after: stateAfter(base, [...older, a]),
      proposedTitle: typeof proposedTitle === "string" ? proposedTitle : null,
      undone: undoMark(s?.finalPayload)?.changeId === a.id,
      undoable: reason === null, notUndoableReason: reason,
    }];
  });
}

export const gripActionsRouter = router({
  list: protectedProcedure
    .input(z.object({ sinceDays: z.number().int().min(1).max(90).default(7) }).default({}))
    .query(({ ctx, input }) => listGripActions(ctx.db, input.sinceDays)),

  /**
   * One tap, one transaction. A double tap is harmless: the first undo's own
   * row is newer than Grip's change, so the second is refused "al aangepast"
   * and appends nothing.
   */
  undo: protectedProcedure.input(z.object({ changeId: z.string().uuid() }))
    .mutation(({ ctx, input }) => ctx.db.transaction(async (tx) => {
      const c = schema.documentStatusChanges;
      const [change] = await tx.select().from(c).where(eq(c.id, input.changeId));
      if (!change || change.actor !== APP_ACTOR)
        throw new TRPCError({ code: "NOT_FOUND", message: "Not a change Grip made" });
      const documentId = change.documentId;
      // The per-document lock every writer of change rows takes, so the
      // newer-row check below is not a TOCTOU against a rename landing now.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${documentId}::text, 0))`);
      const kind = gripActionKind(change);
      const current = await effectiveDocument(tx, documentId);
      const rows = await tx.select().from(c).where(eq(c.documentId, documentId))
        .orderBy(asc(c.createdAt), asc(c.id));
      const reason = notUndoableReason({ kind, purged: current.purge !== null,
        newerExists: rows.some((r) => isNewer(r, change)) });
      if (reason === "naam staat ook op de NAS")
        throw new TRPCError({ code: "BAD_REQUEST", message: reason });
      if (reason !== null) throw new TRPCError({ code: "CONFLICT", message: reason });

      const [doc] = await tx.select().from(schema.documents)
        .where(eq(schema.documents.id, documentId));
      const before = stateAfter({ status: doc.status, title: doc.title, docType: doc.docType },
        rows.filter((r) => r.id !== change.id && !isNewer(r, change)));
      // A soort can never go back to NULL under the newest-opinion rule (a
      // NULL column is "no opinion"), so "no soort" is restored as "", which
      // docTypeKeySql folds to the same "Zonder soort" key as NULL.
      const [row] = await tx.insert(c).values({
        documentId, status: before.status as ChangeRow["status"],
        title: before.title, docType: before.docType ?? "",
        partyId: current.effectivePartyId ?? undefined,
      }).returning();
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: documentId,
        payload: documentStatusChangePayloadWithParty(row) });

      if (change.suggestionId) {
        const [s] = await tx.select({ finalPayload: schema.suggestions.finalPayload })
          .from(schema.suggestions).where(eq(schema.suggestions.id, change.suggestionId));
        const mark: UndoMark = { at: new Date().toISOString(), changeId: change.id, undoChangeId: row.id };
        await tx.update(schema.suggestions).set({
          finalPayload: { ...((s?.finalPayload ?? {}) as Record<string, unknown>), undo: mark },
        }).where(eq(schema.suggestions.id, change.suggestionId));
      }
      return { documentId, undoChangeId: row.id };
    })),
});
