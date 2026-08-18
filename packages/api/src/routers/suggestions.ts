import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { canonicalJson } from "@verder/core";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";
import { insertEntry } from "./entries";

const entryForApproval = z.object({
  occurredAt: z.coerce.date(),
  channel: z.enum(["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"]),
  direction: z.enum(["inbound", "outbound", "internal"]),
  summary: z.string().min(1),
  details: z.string().optional(),
  source: z.enum(["manual", "gmail-watch", "nas-watch"]),
  sourceRef: z.string().optional(),
  participantPartyIds: z.array(z.string().uuid()),
  documentIds: z.array(z.string().uuid()),
  actionItems: z.array(z.object({
    description: z.string().min(1),
    ownerPartyId: z.string().uuid().optional(),
    dueAt: z.coerce.date().optional(),
    clarity: z.enum(["clear", "ambiguous", "already-provided"]).default("clear"),
  })),
});

export const suggestionsRouter = router({
  list: protectedProcedure.input(z.object({
    status: z.enum(["pending", "approved", "edited", "rejected", "needs-manual"]).default("pending"),
  })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(schema.suggestions)
      .where(eq(schema.suggestions.status, input.status))
      .orderBy(desc(schema.suggestions.createdAt));
    return Promise.all(rows.map(async (s) => ({
      ...s,
      rawEmail: s.rawEmailId
        ? (await ctx.db.select().from(schema.rawEmails)
            .where(eq(schema.rawEmails.id, s.rawEmailId)))[0] ?? null
        : null,
      document: s.documentId
        ? (await ctx.db.select().from(schema.documents)
            .where(eq(schema.documents.id, s.documentId)))[0] ?? null
        : null,
    })));
  }),

  approveEntry: protectedProcedure.input(z.object({
    id: z.string().uuid(), entry: entryForApproval,
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const [s] = await tx.select().from(schema.suggestions)
        .where(eq(schema.suggestions.id, input.id));
      if (!s || (s.status !== "pending" && s.status !== "needs-manual"))
        throw new Error("Suggestion not open for review");
      const entry = await insertEntry(tx, ctx.userId, input.entry, { eventType: "entry.created" });
      const unchanged = s.proposed !== null &&
        canonicalJson(input.entry.summary) === canonicalJson((s.proposed as { summary?: string }).summary) &&
        (s.proposed as { details?: string }).details === (input.entry.details ?? undefined);
      await tx.update(schema.suggestions).set({
        status: unchanged ? "approved" : "edited",
        finalPayload: JSON.parse(JSON.stringify(input.entry)),
        resultEntryId: entry.id, verdictAt: new Date(),
      }).where(eq(schema.suggestions.id, input.id));
      return { entryId: entry.id };
    })),

  approveDocumentMeta: protectedProcedure.input(z.object({
    id: z.string().uuid(), title: z.string().min(1), docType: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const [s] = await tx.select().from(schema.suggestions)
        .where(eq(schema.suggestions.id, input.id));
      if (!s?.documentId) throw new Error("Suggestion has no document");
      await tx.insert(schema.documentStatusChanges).values({
        documentId: s.documentId, status: "filed", title: input.title, docType: input.docType });
      await appendLedgerEvent(tx, {
        eventType: "document.updated", entityType: "document", entityId: s.documentId,
        payload: { id: s.documentId, status: "filed", title: input.title, docType: input.docType ?? null } });
      await tx.update(schema.suggestions).set({
        status: "approved", finalPayload: { title: input.title, docType: input.docType ?? null },
        verdictAt: new Date(),
      }).where(eq(schema.suggestions.id, input.id));
    })),

  reject: protectedProcedure.input(z.object({
    id: z.string().uuid(), reason: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.update(schema.suggestions).set({
      status: "rejected", finalPayload: { reason: input.reason ?? null }, verdictAt: new Date(),
    }).where(eq(schema.suggestions.id, input.id))),
});
