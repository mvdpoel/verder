import { z } from "zod";
import { asc } from "drizzle-orm";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";

export const partiesRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.db.select().from(schema.parties).orderBy(asc(schema.parties.name))),
  create: protectedProcedure.input(z.object({
    kind: z.enum(["person", "organization"]),
    name: z.string().min(1),
    organization: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    notes: z.string().optional(),
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const [p] = await tx.insert(schema.parties).values(input).returning();
      await appendLedgerEvent(tx, {
        eventType: "party.created", entityType: "party", entityId: p.id,
        payload: { id: p.id, kind: p.kind, name: p.name, organization: p.organization,
          email: p.email, phone: p.phone, notes: p.notes },
      });
      return p;
    })),
});
