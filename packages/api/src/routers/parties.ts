import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { asc, eq, sql } from "drizzle-orm";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";
import { loadTalkingPoints } from "../talking-points-load";

export const partiesRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.db.select().from(schema.parties).orderBy(asc(schema.parties.name))),

  /** One party; NOT_FOUND when the id names none. */
  get: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [p] = await ctx.db.select().from(schema.parties)
        .where(eq(schema.parties.id, input.id));
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Party not found" });
      return p;
    }),

  /**
   * Every party, the one Martin was most recently in contact with first: by
   * the newest `log_entries.occurred_at` among the entries it took part in
   * (through entry_participants), then by name. A party with no entry at all
   * comes last, by name. The phone's voice quick-log picks from this, because
   * the call he is logging is nearly always with someone he spoke to lately.
   */
  recent: protectedProcedure.query(({ ctx }) => {
    const last = sql`max(${schema.logEntries.occurredAt})`;
    return ctx.db.select({
      id: schema.parties.id, kind: schema.parties.kind, name: schema.parties.name,
      organization: schema.parties.organization, email: schema.parties.email,
      lastContactAt: last.mapWith(schema.logEntries.occurredAt),
    }).from(schema.parties)
      .leftJoin(schema.entryParticipants, eq(schema.entryParticipants.partyId, schema.parties.id))
      .leftJoin(schema.logEntries, eq(schema.logEntries.id, schema.entryParticipants.entryId))
      .groupBy(schema.parties.id)
      .orderBy(sql`${last} DESC NULLS LAST`, asc(schema.parties.name), asc(schema.parties.id));
  }),

  /**
   * What to tell and what to ask this party during a call (Added 2026-11-03):
   * deterministic points read off the dossier, plus the one AI line when the
   * host drafter has made it. Read-only; NOT_FOUND when the id names no party.
   */
  talkingPoints: protectedProcedure.input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => loadTalkingPoints(ctx.db, input.id)),

  create: protectedProcedure.input(z.object({
    kind: z.enum(["person", "organization"]),
    name: z.string().min(1),
    organization: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    notes: z.string().optional(),
    parentPartyId: z.string().uuid().nullish(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const [p] = await tx.insert(schema.parties).values(input).returning();
      await appendLedgerEvent(tx, {
        eventType: "party.created", entityType: "party", entityId: p.id,
        payload: { id: p.id, kind: p.kind, name: p.name, organization: p.organization,
          email: p.email, phone: p.phone, notes: p.notes, parentPartyId: p.parentPartyId },
      });
      return p;
    })),
});
