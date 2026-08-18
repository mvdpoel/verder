import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";

const entryInput = z.object({
  occurredAt: z.coerce.date(),
  channel: z.enum(["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"]),
  direction: z.enum(["inbound", "outbound", "internal"]),
  summary: z.string().min(1),
  details: z.string().optional(),
  source: z.enum(["manual", "gmail-watch", "nas-watch"]).default("manual"),
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

export type EntryInput = z.infer<typeof entryInput>;

export async function insertEntry(
  tx: Db, userId: string, input: EntryInput,
  opts: { eventType: "entry.created" | "entry.corrected"; supersedesId?: string }
) {
  const [entry] = await tx.insert(schema.logEntries).values({
    occurredAt: input.occurredAt, channel: input.channel, direction: input.direction,
    summary: input.summary, details: input.details, source: input.source,
    sourceRef: input.sourceRef, supersedesId: opts.supersedesId, createdBy: userId,
  }).returning();
  if (input.participantPartyIds.length)
    await tx.insert(schema.entryParticipants).values(
      input.participantPartyIds.map((partyId) => ({ entryId: entry.id, partyId })));
  if (input.documentIds.length)
    await tx.insert(schema.entryDocuments).values(
      input.documentIds.map((documentId) => ({ entryId: entry.id, documentId })));
  const items = [...input.actionItems].sort((a, b) => a.description.localeCompare(b.description));
  if (items.length)
    await tx.insert(schema.actionItems).values(
      items.map((a) => ({ entryId: entry.id, description: a.description,
        ownerPartyId: a.ownerPartyId, dueAt: a.dueAt, clarity: a.clarity })));
  await appendLedgerEvent(tx, {
    eventType: opts.eventType, entityType: "log_entry", entityId: entry.id,
    payload: {
      id: entry.id, occurredAt: input.occurredAt.toISOString(),
      channel: input.channel, direction: input.direction,
      summary: input.summary, details: input.details ?? null,
      source: input.source, sourceRef: input.sourceRef ?? null,
      supersedesId: opts.supersedesId ?? null,
      participantPartyIds: [...input.participantPartyIds].sort(),
      documentIds: [...input.documentIds].sort(),
      actionItems: items.map((a) => ({ description: a.description,
        ownerPartyId: a.ownerPartyId ?? null,
        dueAt: a.dueAt?.toISOString() ?? null, clarity: a.clarity })),
    },
  });
  return entry;
}

export const entriesRouter = router({
  create: protectedProcedure.input(entryInput).mutation(({ ctx, input }) =>
    ctx.db.transaction((tx) => insertEntry(tx, ctx.userId, input, { eventType: "entry.created" }))),

  correct: protectedProcedure
    .input(entryInput.extend({ supersedesId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      ctx.db.transaction((tx) => insertEntry(tx, ctx.userId, input,
        { eventType: "entry.corrected", supersedesId: input.supersedesId }))),

  list: protectedProcedure.input(z.object({
    channel: z.enum(["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(schema.logEntries)
      .where(input.channel ? eq(schema.logEntries.channel, input.channel) : undefined)
      .orderBy(desc(schema.logEntries.occurredAt)).limit(input.limit);
    return rows;
  }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [entry] = await ctx.db.select().from(schema.logEntries)
        .where(eq(schema.logEntries.id, input.id));
      if (!entry) throw new Error("Entry not found");
      const participants = await ctx.db.select().from(schema.entryParticipants)
        .where(eq(schema.entryParticipants.entryId, entry.id));
      const docs = await ctx.db.select().from(schema.entryDocuments)
        .where(eq(schema.entryDocuments.entryId, entry.id));
      const actionItems = await ctx.db.select().from(schema.actionItems)
        .where(eq(schema.actionItems.entryId, entry.id));
      const [successor] = await ctx.db.select().from(schema.logEntries)
        .where(eq(schema.logEntries.supersedesId, entry.id));
      return { ...entry, participants, documents: docs, actionItems,
        supersededBy: successor?.id ?? null };
    }),
});
