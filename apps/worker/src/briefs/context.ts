import { desc, eq, inArray, or, sql } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { addressesIn } from "@verder/api/src/talking-points-load";
import { effectiveTaskStatuses } from "@verder/api/src/task-decide";

/**
 * WHAT THE BRIEF DRAFTER MAY SEE about one party: the newest mail to and from
 * them (and their contact persons), the tasks linked to them and the debts
 * they are on. Stored on the `party_briefs` row when the prompt is built, so
 * the store step validates the answer against EXACTLY what the model was shown
 * (golden rule), whatever the dossier did in the meantime.
 */
export interface BriefContext {
  party: { id: string; name: string };
  mails: { id: string; direction: "inbound" | "outbound"; from: string; subject: string; sentAt: string; body: string }[];
  tasks: { id: string; title: string; status: string }[];
  debts: { id: string; creditorName: string; claimedCents: number | null }[];
}

export const BRIEF_MAILS = 6;
export const BRIEF_TASKS = 8;
export const BRIEF_BODY_MAX = 1500;

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The party plus its contact persons — the ids whose mail is "theirs". */
export async function partyFamily(db: Db, partyId: string) {
  const rows = await db.select({ id: schema.parties.id, name: schema.parties.name, email: schema.parties.email,
    parentPartyId: schema.parties.parentPartyId })
    .from(schema.parties).where(or(eq(schema.parties.id, partyId), eq(schema.parties.parentPartyId, partyId)));
  const party = rows.find((r) => r.id === partyId);
  return party ? { party, ids: rows.map((r) => r.id),
    emails: new Set(rows.map((r) => r.email).filter((e): e is string => !!e).map((e) => asciiLower(e.trim()))) } : null;
}

/** null when the party does not exist or there is nothing to summarise. */
export async function gatherBriefContext(db: Db, partyId: string): Promise<BriefContext | null> {
  const fam = await partyFamily(db, partyId);
  if (!fam) return null;

  let mails: BriefContext["mails"] = [];
  if (fam.emails.size) {
    const r = schema.rawEmails;
    const rows = await db.select({ id: r.id, fromAddr: r.fromAddr, toAddr: r.toAddr, subject: r.subject,
      sentAt: r.sentAt, bodyText: r.bodyText }).from(r)
      .where(or(...[...fam.emails].map((e) =>
        sql`strpos(lower(${r.fromAddr}), ${e}) > 0 OR strpos(lower(${r.toAddr}), ${e}) > 0`)))
      .orderBy(desc(r.sentAt), desc(r.id)).limit(100);
    mails = rows.flatMap((m) => {
      const inbound = addressesIn(m.fromAddr).some((a) => fam.emails.has(a));
      const outbound = !inbound && addressesIn(m.toAddr).some((a) => fam.emails.has(a));
      if (!inbound && !outbound) return [];
      return [{ id: m.id, direction: inbound ? "inbound" as const : "outbound" as const,
        from: m.fromAddr.slice(0, 200), subject: m.subject.slice(0, 300), sentAt: m.sentAt.toISOString(),
        body: m.bodyText.replace(/\r\n/g, "\n").slice(0, BRIEF_BODY_MAX) }];
    }).slice(0, BRIEF_MAILS);
  }

  const debts = await db.selectDistinct({ id: schema.debts.id, creditorName: schema.debts.creditorName,
    claimedCents: schema.debts.claimedCents }).from(schema.debts)
    .leftJoin(schema.debtParties, eq(schema.debtParties.debtId, schema.debts.id))
    .where(or(inArray(schema.debts.creditorPartyId, fam.ids), inArray(schema.debtParties.partyId, fam.ids)));

  const taskRows = await db.select({ id: schema.tasks.id, title: schema.tasks.title }).from(schema.tasks)
    .where(inArray(schema.tasks.assigneePartyId, fam.ids))
    .orderBy(desc(schema.tasks.createdAt)).limit(BRIEF_TASKS * 2);
  const statuses = await effectiveTaskStatuses(db, taskRows.map((t) => t.id));
  const tasks = taskRows.map((t) => ({ id: t.id, title: t.title.slice(0, 200), status: statuses.get(t.id) ?? "open" }))
    .filter((t) => t.status !== "dropped").slice(0, BRIEF_TASKS);

  if (!mails.length && !tasks.length && !debts.length) return null;
  return { party: { id: fam.party.id, name: fam.party.name }, mails, tasks, debts };
}
