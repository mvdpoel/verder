import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { canonicalJson } from "@verder/core";
import { schema } from "@verder/db";
import { protectedProcedure, router } from "../trpc";
import { appendLedgerEvent } from "../ledger";
import { insertEntry } from "./entries";
import { debtFields, itemFields } from "./registry";
import { taskFields } from "./tasks";

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

/**
 * True when every create-input field the miner actually proposed matches the
 * final submitted value (deep compare via canonical JSON; null and absent are
 * equivalent). Fields absent from the proposed payload are not edits — the
 * miner never suggested them. The verdict label must be truthful: "approved"
 * may only mean Martin accepted the suggestion unedited (golden rule).
 */
function unchangedFromProposal(
  shapeKeys: string[], proposed: unknown, final: Record<string, unknown>,
): boolean {
  if (proposed === null || typeof proposed !== "object") return false;
  const p = proposed as Record<string, unknown>;
  return shapeKeys.every((key) =>
    !(key in p) || canonicalJson(final[key] ?? null) === canonicalJson(p[key] ?? null));
}

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
      // FOR UPDATE: a concurrent approve/reject waits on the row lock and then
      // sees the committed verdict — double-approve is impossible.
      const [s] = await tx.select().from(schema.suggestions)
        .where(eq(schema.suggestions.id, input.id)).for("update");
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

  // Registry approvals (Task 11): the miner only ever suggested — these are the
  // single doorway through which a candidate becomes a registry record.
  approveRegistryItem: protectedProcedure.input(z.object({
    id: z.string().uuid(), item: itemFields,
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      // FOR UPDATE: a concurrent approve/reject waits on the row lock and then
      // sees the committed verdict — double-approve is impossible.
      const [s] = await tx.select().from(schema.suggestions)
        .where(eq(schema.suggestions.id, input.id)).for("update");
      if (!s || (s.status !== "pending" && s.status !== "needs-manual"))
        throw new Error("Suggestion not open for review");
      if (s.kind !== "registry-item") throw new Error("Not a registry-item suggestion");
      const p = (s.proposed ?? {}) as {
        name?: string; category?: string; transactionIds?: unknown; discoveredVia?: string };
      // discoveredVia comes from the mining payload (bank/paypal/apple), not
      // from whatever the form defaulted to. Guard on !== undefined: the schema
      // field carries .default("manual"), so safeParse(undefined) would
      // "succeed" as manual and silently discard the client-sent value.
      const viaParsed = p.discoveredVia !== undefined
        ? itemFields.shape.discoveredVia.safeParse(p.discoveredVia)
        : null;
      const finalItem = {
        ...input.item,
        discoveredVia: viaParsed?.success ? viaParsed.data : input.item.discoveredVia,
      };
      const [item] = await tx.insert(schema.financialItems).values(finalItem).returning();
      // Evidence charges auto-link to the new item. A malformed payload fails
      // loudly — approving with half the evidence silently missing is worse
      // than a visible error.
      const rawTxIds = Array.isArray(p.transactionIds) ? p.transactionIds : [];
      if (!rawTxIds.every((x): x is string => typeof x === "string"))
        throw new Error("Suggestion payload has malformed transactionIds");
      const txIds = rawTxIds;
      if (txIds.length > 0) {
        // `financialItemId IS NULL`: never steal evidence already claimed by
        // another item; the count check makes missing/claimed charges loud.
        const linked = await tx.update(schema.transactions).set({ financialItemId: item.id })
          .where(and(inArray(schema.transactions.id, txIds),
            isNull(schema.transactions.financialItemId)))
          .returning({ id: schema.transactions.id });
        if (linked.length !== txIds.length)
          throw new Error(
            `Evidence link failed: ${txIds.length} transactions expected, ` +
            `${linked.length} linkable (missing or already linked to another item)`);
      }
      const unchanged =
        unchangedFromProposal(Object.keys(itemFields.shape), s.proposed, finalItem);
      await tx.update(schema.suggestions).set({
        status: unchanged ? "approved" : "edited",
        // finalPayload records what was actually stored (incl. the resolved
        // discoveredVia), not just what the form happened to send.
        finalPayload: JSON.parse(JSON.stringify(finalItem)),
        verdictAt: new Date(),
      }).where(eq(schema.suggestions.id, input.id));
      return { itemId: item.id };
    })),

  approveDebt: protectedProcedure.input(z.object({
    id: z.string().uuid(), debt: debtFields,
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      // FOR UPDATE: a concurrent approve/reject waits on the row lock and then
      // sees the committed verdict — double-approve is impossible.
      const [s] = await tx.select().from(schema.suggestions)
        .where(eq(schema.suggestions.id, input.id)).for("update");
      if (!s || (s.status !== "pending" && s.status !== "needs-manual"))
        throw new Error("Suggestion not open for review");
      if (s.kind !== "debt") throw new Error("Not a debt suggestion");
      const { references, ...rest } = input.debt;
      const [debt] = await tx.insert(schema.debts)
        .values({ ...rest, references_: references }).returning();
      const unchanged =
        unchangedFromProposal(Object.keys(debtFields.shape), s.proposed, input.debt);
      await tx.update(schema.suggestions).set({
        status: unchanged ? "approved" : "edited",
        finalPayload: JSON.parse(JSON.stringify(input.debt)),
        verdictAt: new Date(),
      }).where(eq(schema.suggestions.id, input.id));
      return { debtId: debt.id };
    })),

  // Task approvals (sub-project 3, Task 6): the single doorway through which a
  // mined action item becomes a task. Rejection reuses the shared `reject`.
  approveTask: protectedProcedure.input(z.object({
    id: z.string().uuid(), task: taskFields,
  })).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      // FOR UPDATE: a concurrent approve/reject waits on the row lock and then
      // sees the committed verdict — double-approve is impossible.
      const [s] = await tx.select().from(schema.suggestions)
        .where(eq(schema.suggestions.id, input.id)).for("update");
      if (!s || (s.status !== "pending" && s.status !== "needs-manual"))
        throw new TRPCError({ code: "CONFLICT", message: "Suggestion not open for review" });
      if (s.kind !== "task")
        throw new TRPCError({ code: "BAD_REQUEST", message: "Not a task suggestion" });
      // Strict link validation: every referenced id must exist. The FKs would
      // also refuse, but a named error beats a raw constraint violation, and
      // the throw rolls the whole transaction back — no half-approved state.
      const missing = (field: string): never => {
        throw new TRPCError({
          code: "BAD_REQUEST", message: `Linked ${field} does not exist` });
      };
      const t = input.task;
      if (t.assigneePartyId != null && !(await tx.select({ id: schema.parties.id })
        .from(schema.parties).where(eq(schema.parties.id, t.assigneePartyId))).length)
        missing("assigneePartyId");
      if (t.entryId != null && !(await tx.select({ id: schema.logEntries.id })
        .from(schema.logEntries).where(eq(schema.logEntries.id, t.entryId))).length)
        missing("entryId");
      if (t.financialItemId != null && !(await tx.select({ id: schema.financialItems.id })
        .from(schema.financialItems).where(eq(schema.financialItems.id, t.financialItemId))).length)
        missing("financialItemId");
      if (t.debtId != null && !(await tx.select({ id: schema.debts.id })
        .from(schema.debts).where(eq(schema.debts.id, t.debtId))).length)
        missing("debtId");
      if (t.documentId != null && !(await tx.select({ id: schema.documents.id })
        .from(schema.documents).where(eq(schema.documents.id, t.documentId))).length)
        missing("documentId");
      const [task] = await tx.insert(schema.tasks)
        .values({ ...t, createdBy: ctx.userId }).returning();
      // Truthful edit diff over ALL taskFields keys present in the proposed
      // payload. The mined dueAt is a "YYYY-MM-DD" string while the submitted
      // value is a Date (which canonicalJson serializes as {}) — normalize
      // both sides to ISO instants so an unchanged date reads "approved".
      // assigneePartyId is never proposed (only assigneeHint), so picking an
      // assignee is not an edit — unchangedFromProposal skips absent keys.
      const p = (s.proposed ?? {}) as Record<string, unknown>;
      const proposedDue = typeof p.dueAt === "string" ? new Date(p.dueAt) : null;
      const proposedForDiff = { ...p };
      if (proposedDue && !Number.isNaN(proposedDue.getTime()))
        proposedForDiff.dueAt = proposedDue.toISOString();
      // The miner records details: "" when the model gives none; the card
      // submits an empty textarea as absent. Same emptiness — not an edit.
      if (proposedForDiff.details === "") proposedForDiff.details = null;
      const finalTask = { ...t, dueAt: t.dueAt ? t.dueAt.toISOString() : null };
      const unchanged =
        unchangedFromProposal(Object.keys(taskFields.shape), proposedForDiff, finalTask);
      await tx.update(schema.suggestions).set({
        status: unchanged ? "approved" : "edited",
        // finalPayload records what was actually stored, dueAt as ISO instant.
        finalPayload: JSON.parse(JSON.stringify(finalTask)),
        verdictAt: new Date(),
      }).where(eq(schema.suggestions.id, input.id));
      return task;
    })),

  reject: protectedProcedure.input(z.object({
    id: z.string().uuid(), reason: z.string().optional(),
  })).mutation(async ({ ctx, input }) => {
    // Conditional claim: a verdict already given (approved/edited/rejected)
    // stands — reject must never flip it or overwrite the recorded edit diff.
    const claimed = await ctx.db.update(schema.suggestions).set({
      status: "rejected", finalPayload: { reason: input.reason ?? null }, verdictAt: new Date(),
    }).where(and(eq(schema.suggestions.id, input.id),
      inArray(schema.suggestions.status, ["pending", "needs-manual"])))
      .returning({ id: schema.suggestions.id });
    if (claimed.length === 0) throw new Error("Suggestion not open for review");
  }),
});
