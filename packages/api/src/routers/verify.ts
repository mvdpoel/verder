import { z } from "zod";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { canonicalJson, sha256Hex, verifyChain, type ChainEvent } from "@verder/core";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { readFilePath } from "../storage";
import { entryEventPayload } from "./entries";

export const verifyRouter = router({
  run: protectedProcedure.mutation(async ({ ctx }) => {
    const vaultDir = process.env.VAULT_DIR ?? "./vault-files";
    const rows = await ctx.db.select().from(schema.ledgerEvents)
      .orderBy(asc(schema.ledgerEvents.seq));
    const events: ChainEvent[] = rows.map((e) => ({
      seq: e.seq, eventType: e.eventType, entityType: e.entityType,
      entityId: e.entityId, payloadHash: e.payloadHash,
      prevHash: e.prevHash, eventHash: e.eventHash }));
    let checkedFiles = 0;
    const res = await verifyChain(events, async (e) => {
      if (e.eventType === "entry.created" || e.eventType === "entry.corrected") {
        // Rebuild the canonical payload from the live rows — any edit to a
        // stored entry (or its participants/documents/action items) surfaces
        // as a payload_hash_mismatch at this seq.
        const [entry] = await ctx.db.select().from(schema.logEntries)
          .where(eq(schema.logEntries.id, e.entityId));
        if (!entry) return "missing-entry-row".padEnd(64, "0");
        const parts = await ctx.db.select().from(schema.entryParticipants)
          .where(eq(schema.entryParticipants.entryId, entry.id));
        const docs = await ctx.db.select().from(schema.entryDocuments)
          .where(eq(schema.entryDocuments.entryId, entry.id));
        const items = await ctx.db.select().from(schema.actionItems)
          .where(eq(schema.actionItems.entryId, entry.id));
        return sha256Hex(canonicalJson(entryEventPayload({
          id: entry.id, occurredAt: entry.occurredAt,
          channel: entry.channel, direction: entry.direction,
          summary: entry.summary, details: entry.details,
          source: entry.source, sourceRef: entry.sourceRef,
          supersedesId: entry.supersedesId,
          participantPartyIds: parts.map((p) => p.partyId),
          documentIds: docs.map((d) => d.documentId),
          actionItems: items.map((a) => ({ description: a.description,
            ownerPartyId: a.ownerPartyId, dueAt: a.dueAt, clarity: a.clarity })),
        })));
      }
      if (e.eventType !== "document.ingested") return e.payloadHash;
      const [doc] = await ctx.db.select().from(schema.documents)
        .where(eq(schema.documents.id, e.entityId));
      if (!doc) return "missing-document-row".padEnd(64, "0");
      try {
        const buf = await readFile(readFilePath(vaultDir, doc.sha256));
        checkedFiles++;
        return sha256Hex(buf) === doc.sha256 ? e.payloadHash : "file-hash-mismatch".padEnd(64, "0");
      } catch { return "file-missing".padEnd(64, "0"); }
    });
    return { ...res, headHash: rows.at(-1)?.eventHash ?? null, checkedFiles };
  }),

  exportRange: protectedProcedure.input(z.object({
    from: z.coerce.date(), to: z.coerce.date(),
  })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(schema.logEntries)
      .where(and(gte(schema.logEntries.occurredAt, input.from),
                 lte(schema.logEntries.occurredAt, input.to)))
      .orderBy(asc(schema.logEntries.occurredAt));
    const [last] = await ctx.db.select().from(schema.ledgerEvents)
      .orderBy(desc(schema.ledgerEvents.seq)).limit(1);
    const entries = await Promise.all(rows.map(async (entry) => {
      const parts = await ctx.db
        .select({ name: schema.parties.name })
        .from(schema.entryParticipants)
        .innerJoin(schema.parties, eq(schema.entryParticipants.partyId, schema.parties.id))
        .where(eq(schema.entryParticipants.entryId, entry.id));
      const docs = await ctx.db
        .select({ title: schema.documents.title, sha256: schema.documents.sha256 })
        .from(schema.entryDocuments)
        .innerJoin(schema.documents, eq(schema.entryDocuments.documentId, schema.documents.id))
        .where(eq(schema.entryDocuments.entryId, entry.id));
      const items = await ctx.db.select().from(schema.actionItems)
        .where(eq(schema.actionItems.entryId, entry.id));
      return { ...entry, participants: parts.map((p) => p.name), documents: docs, actionItems: items };
    }));
    return { generatedAt: new Date().toISOString(), from: input.from.toISOString(),
      to: input.to.toISOString(), headHash: last?.eventHash ?? null, entries };
  }),
});
