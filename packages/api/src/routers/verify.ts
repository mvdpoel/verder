import { z } from "zod";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { runFullVerification } from "../verification";

export const verifyRouter = router({
  // Full chain verification lives in ../verification.ts (runFullVerification)
  // so the nightly worker script and this router share one implementation.
  run: protectedProcedure.mutation(({ ctx }) =>
    runFullVerification(ctx.db, process.env.VAULT_DIR ?? "./vault-files")),

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
