import { and, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { dayKey } from "@verder/api/src/amsterdam";
import { effectiveTaskStatuses } from "@verder/api/src/task-decide";
import { PROPOSAL_CLOCK_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "../heartbeat";
import { resolveSenderPartyId, senderAddress } from "../gmail";
import { normaliseMessageId } from "../mail/message-id";
import { asciiLower } from "../mail/relevance";
import { isOwnOutbound, mailPriority, matchesList, prioritySets, type MailPriority, type PrioritySets } from "../mail/priority";
import { mailboxList } from "../mail/threading";
import type { NotifyFn, NotifyLevel } from "../notify/notify";
import { buildProposalPrompt } from "./draft-prompt";
import { createProposal, type CreateDeps } from "./create";

/**
 * THE CLOCKS (spec §6.4 "keep after it", §6.3, §12.10). One worker tick, every
 * 15 minutes, that notices time passing:
 *
 *   0. DAYTIME ONLY. Every push here is a nudge, two of the three at
 *      `time-sensitive`, which breaks through Focus. Outside ALERT_DAY_START_HOUR
 *      to ALERT_DAY_END_HOUR Amsterdam time the tick does nothing but record its
 *      row; what came due at night goes out on the first morning tick. Without
 *      it the plan's literal rules fire at night EVERY time, not by accident:
 *      a silence clock counts Amsterdam calendar days, so it becomes due on the
 *      first tick after midnight, and a date-only deadline is stored as UTC
 *      midnight, so "within 24 h" first held at ~01:15 the night before.
 *
 *   1. REMINDER. A `pending` proposal untouched for 24 elapsed hours gets ONE
 *      push, ever. The notify goes FIRST, outside any transaction (no DB
 *      transaction is held open across APNs/web-push I/O), carrying
 *      `reminder:<id>` as its dedup key; then a conditional UPDATE sets
 *      `reminded_at`. A crash between the two re-asks a notify that dedups.
 *
 *   2. SILENCE (§12.10). One clock per Gmail thread, started only by an
 *      outbound message — Martin's own `raw_emails` row, or a `sent` proposal —
 *      and stopped by any inbound reply. When it has run PROPOSAL_FOLLOWUP_DAYS
 *      Amsterdam calendar days on a Verder or creditor thread: one push, and one
 *      `follow-up` proposal in `drafting` for the host drafter.
 *        - A JMAP thread has no clock: Stalwart receives no live mail while the
 *          MX is Gmail, so a reply would never be seen there.
 *        - A sent proposal starts a clock only in a thread the poller holds rows
 *          for. A mail-agent reply to a watchlist sender (Task 20) is sent into a
 *          thread verder never ingests, so its answer would never stop the
 *          clock and the chase would be a guess.
 *        - A re-ingested row that IS a proposal's sent mail is represented by
 *          the PROPOSAL (matched on Message-ID or Gmail id, as
 *          `proposalForOwnSentMail` does), so its re-ingest landing between two
 *          ticks changes neither the clock's identity nor its dedup key.
 *        - Idempotent three times over: a follow-up that already exists for
 *          this outbound message is never created again, the database refuses a
 *          second one (0039, for a second process or a redelivered job), and
 *          the push dedups on `followup:<threadKey>:<kind>:<id>`.
 *        - BOUNDED BY FOLLOWUP_MAX_SILENCE_DAYS. Not in the plan: the Gmail
 *          backfill put years of Martin's outbound mail in `raw_emails`, so an
 *          unbounded first tick would chase every old thread whose last word
 *          was his and hand the host drafter one `claude -p` run each. A thread
 *          silent for over 30 days is a closed matter, not a late reply.
 *
 *   3. DUE (§6.3). A task Martin is the one to act on — effective status
 *      `open` or `in-progress` (Martin 2026-10-31: in-progress counts as waiting
 *      on him; `waiting` waits on someone else) — whose deadline falls within
 *      24 elapsed hours, overdue included (`dueAlert`). A DATE-ONLY deadline —
 *      every one the web form and the suggestion card write, `new Date("YYYY-
 *      MM-DD")`, i.e. UTC midnight — means the END of that day, so it alerts
 *      "Vandaag" on the morning of the day and is "Te laat" only the day after;
 *      read as an instant it was already overdue at 01:00 on its own day. The
 *      dedup key is `due:<taskId>:<dueAt ISO>`, so a task alerts once per due
 *      date: an overdue task once, not every quarter hour, and a moved
 *      deadline once more.
 *
 * Nothing here is evidence and nothing appends a ledger event. Each section is
 * error-isolated from the other two, and the tick records one `proposal-clock`
 * row.
 */

export const DEFAULT_FOLLOWUP_DAYS = 7;
/** Pushes go out from 08:00 up to (not including) 22:00, Amsterdam time. */
export const ALERT_DAY_START_HOUR = 8;
export const ALERT_DAY_END_HOUR = 22;
/** A clock past this many silent days is a closed matter and is never chased. */
export const FOLLOWUP_MAX_SILENCE_DAYS = 30;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface ThreadState {
  threadKey: string;
  priority: "verder" | "creditor";
  lastOutbound: { kind: "raw-email" | "proposal"; id: string };
  lastOutboundAt: Date;
  lastInboundAt: Date | null;
  /** What the push text's "who has been silent" is resolved from — lazily, and
   *  only for a thread that is actually chased. */
  who?: Who;
}

/** The proposal's party, the inbound senders newest first, whom Martin wrote to. */
export interface Who { partyId: string | null; inboundFrom: string[]; to: string | null }

export interface ClockDeps {
  db: Db;
  notify: NotifyFn;
  /** Creates the follow-up proposal and returns its id (`followUpCreator`). */
  createFollowUp: (t: ThreadState) => Promise<string>;
  now?: () => Date;
  /** Defaults to PROPOSAL_FOLLOWUP_DAYS, else 7. */
  followUpDays?: number;
}

export interface ClockResult { reminded: number; followUps: number; due: number; quiet?: true }

// ---- pure ------------------------------------------------------------------

const dayNumber = (d: Date): number => {
  const [y, m, day] = dayKey(d).split("-").map(Number);
  return Date.UTC(y, m - 1, day) / DAY;
};

/** Amsterdam calendar days from `lastOutbound` to `now`: a DST change makes a
 *  day 23 or 25 hours long, and a message at 23:30 is that day's, not the next. */
export function silentFor(lastOutbound: Date, now: Date): number {
  return dayNumber(now) - dayNumber(lastOutbound);
}

/** The outbound message is the newest word in the thread AND it has been silent long enough. */
export function followUpDue(t: ThreadState, now: Date, days: number): boolean {
  if (t.lastInboundAt && t.lastInboundAt.getTime() >= t.lastOutboundAt.getTime()) return false;
  return silentFor(t.lastOutboundAt, now) >= days;
}

const HOUR_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Amsterdam", hour: "2-digit", hourCycle: "h23",
});

/** True while a push may go out: daytime in Amsterdam. */
export function isAlertHour(now: Date): boolean {
  const h = Number(HOUR_FMT.format(now));
  return h >= ALERT_DAY_START_HOUR && h < ALERT_DAY_END_HOUR;
}

/** A deadline the web form or the suggestion card wrote from a bare date. */
export function isDateOnly(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0
    && d.getUTCMilliseconds() === 0;
}

/**
 * Whether a deadline alerts at `now`, and how it is worded; null while it is
 * more than 24 hours off. A date-only deadline (UTC midnight of the day typed)
 * is the END of that Amsterdam day: due from the start of the day, overdue the
 * day after. Any other value is an instant.
 */
export function dueAlert(dueAt: Date, now: Date): "Te laat" | "Vandaag" | "Morgen" | null {
  const today = dayKey(now);
  if (isDateOnly(dueAt)) {
    const day = dueAt.toISOString().slice(0, 10);
    return today > day ? "Te laat" : today === day ? "Vandaag" : null;
  }
  if (dueAt.getTime() < now.getTime()) return "Te laat";
  if (dueAt.getTime() >= now.getTime() + DAY) return null;
  return dayKey(dueAt) === today ? "Vandaag" : "Morgen";
}

export function followUpDays(): number {
  const n = Number(process.env.PROPOSAL_FOLLOWUP_DAYS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_FOLLOWUP_DAYS;
}

const LEVEL: Record<MailPriority, NotifyLevel> = {
  verder: "time-sensitive", creditor: "active", other: "passive",
};
const RANK: Record<MailPriority, number> = { other: 0, creditor: 1, verder: 2 };

/** "dd-mm" in Amsterdam. */
const dayMonth = (d: Date): string => {
  const [, m, day] = dayKey(d).split("-");
  return `${day}-${m}`;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---- 1. the reminder ---------------------------------------------------------

async function remind(deps: ClockDeps, now: Date): Promise<number> {
  const { db } = deps;
  const due = await db.select({
    id: schema.proposals.id, payload: schema.proposals.payload, priority: schema.proposals.priority,
  }).from(schema.proposals)
    .where(and(eq(schema.proposals.status, "pending"), isNull(schema.proposals.remindedAt),
      lt(schema.proposals.createdAt, new Date(now.getTime() - DAY))));
  let reminded = 0;
  for (const p of due) {
    // Notify first, outside any transaction: the dedup key makes a repeat (a
    // crash before the UPDATE below, a second process) send nothing, and no DB
    // transaction waits on APNs.
    const ask = (p.payload as { ask?: unknown } | null)?.ask;
    const r = await deps.notify({
      kind: "reminder", level: LEVEL[p.priority as MailPriority] ?? "active",
      title: `Wacht nog: ${typeof ask === "string" && ask ? ask : "een voorstel"}`,
      body: "Dit voorstel wacht al een dag op je.",
      link: `verder://proposal/${p.id}`, dedupKey: `reminder:${p.id}`,
    });
    // Once, ever: a later tick no longer selects it.
    await db.update(schema.proposals).set({ remindedAt: now })
      .where(and(eq(schema.proposals.id, p.id), isNull(schema.proposals.remindedAt)));
    if (!r.duplicate) reminded++;
  }
  return reminded;
}

// ---- 2. silence --------------------------------------------------------------

interface Outbound { kind: "raw-email" | "proposal"; id: string; at: Date; priority: MailPriority; partyId: string | null; to: string | null }

/** Every thread whose clock could run: Gmail threads with activity in the window. */
export async function threadStates(db: Db, now: Date, sets?: PrioritySets): Promise<ThreadState[]> {
  const prio = sets ?? await prioritySets(db);
  const since = new Date(now.getTime() - (FOLLOWUP_MAX_SILENCE_DAYS + 2) * DAY);

  // Proposals whose sent mail may come back through the poll. `sending` too:
  // its re-ingest is the proposal's own mail, not Martin's, and must not start
  // a clock of its own before finishSent lands.
  const proposals = await db.select({
    id: schema.proposals.id, status: schema.proposals.status, priority: schema.proposals.priority,
    partyId: schema.proposals.partyId, messageId: schema.proposals.messageId,
    gmailMessageId: schema.proposals.gmailMessageId, gmailThreadId: schema.proposals.gmailThreadId,
    sentAt: schema.proposals.sentAt,
  }).from(schema.proposals)
    .where(or(eq(schema.proposals.status, "sending"),
      and(eq(schema.proposals.status, "sent"), gte(schema.proposals.sentAt, since))));
  const proposalByMid = new Map<string, (typeof proposals)[number]>();
  const proposalByGmail = new Map<string, (typeof proposals)[number]>();
  for (const p of proposals) {
    const mid = p.messageId ? normaliseMessageId(p.messageId) : null;
    if (mid) proposalByMid.set(mid, p);
    if (p.gmailMessageId) proposalByGmail.set(p.gmailMessageId, p);
  }
  const sentThreads = proposals
    .filter((p) => p.status === "sent" && p.gmailThreadId && p.sentAt)
    .map((p) => p.gmailThreadId!);

  const recent = db.select({ t: schema.rawEmails.gmailThreadId }).from(schema.rawEmails)
    .where(and(eq(schema.rawEmails.source, "gmail"), gte(schema.rawEmails.sentAt, since)));
  const rows = await db.select({
    id: schema.rawEmails.id, threadId: schema.rawEmails.gmailThreadId, from: schema.rawEmails.fromAddr,
    to: schema.rawEmails.toAddr, sentAt: schema.rawEmails.sentAt, messageId: schema.rawEmails.messageId,
    gmailMessageId: schema.rawEmails.gmailMessageId,
  }).from(schema.rawEmails)
    .where(and(eq(schema.rawEmails.source, "gmail"), or(
      inArray(schema.rawEmails.gmailThreadId, recent),
      ...(sentThreads.length ? [inArray(schema.rawEmails.gmailThreadId, sentThreads)] : []),
    )));

  type Thread = { outbound: Outbound[]; inbound: { at: Date; from: string; priority: MailPriority }[] };
  const threads = new Map<string, Thread>();
  const thread = (id: string): Thread => {
    let t = threads.get(id);
    if (!t) { t = { outbound: [], inbound: [] }; threads.set(id, t); }
    return t;
  };

  for (const r of rows) {
    if (isOwnOutbound(prio, { from: r.from })) {
      const mid = r.messageId ? normaliseMessageId(r.messageId) : null;
      // A proposal's own sent mail: the PROPOSAL is the outbound message.
      if ((mid && proposalByMid.has(mid)) || proposalByGmail.has(r.gmailMessageId)) {
        thread(r.threadId);
        continue;
      }
      thread(r.threadId).outbound.push({ kind: "raw-email", id: r.id, at: r.sentAt,
        priority: recipientPriority(prio, r.to), partyId: null, to: r.to });
    } else {
      thread(r.threadId).inbound.push({ at: r.sentAt, from: r.from, priority: mailPriority(prio, { from: r.from }) });
    }
  }
  for (const p of proposals) {
    if (p.status !== "sent" || !p.gmailThreadId || !p.sentAt) continue;
    // Only a thread the poller holds rows for can ever see the answer.
    const t = threads.get(p.gmailThreadId);
    if (!t) continue;
    t.outbound.push({ kind: "proposal", id: p.id, at: p.sentAt,
      priority: p.priority as MailPriority, partyId: p.partyId, to: null });
  }

  const out: ThreadState[] = [];
  for (const [threadId, t] of threads) {
    if (t.outbound.length === 0) continue;
    const last = t.outbound.reduce((a, b) => (b.at.getTime() > a.at.getTime() ? b : a));
    const lastIn = t.inbound.reduce<Date | null>(
      (a, b) => (a === null || b.at.getTime() > a.getTime() ? b.at : a), null);
    const priority = [...t.outbound.map((o) => o.priority), ...t.inbound.map((i) => i.priority)]
      .reduce<MailPriority>((a, b) => (RANK[b] > RANK[a] ? b : a), "other");
    if (priority === "other") continue;
    out.push({
      threadKey: `gmail:${threadId}`, priority,
      lastOutbound: { kind: last.kind, id: last.id }, lastOutboundAt: last.at, lastInboundAt: lastIn,
      who: {
        partyId: last.partyId, to: last.to,
        inboundFrom: [...t.inbound].sort((a, b) => b.at.getTime() - a.at.getTime()).map((i) => i.from),
      },
    });
  }
  return out;
}

const isOwn = (sets: PrioritySets, addr: string): boolean =>
  sets.own.some((o) => asciiLower(o.trim()) === addr);

/** The highest priority among the mailboxes Martin wrote to. */
function recipientPriority(sets: PrioritySets, to: string): MailPriority {
  let best: MailPriority = "other";
  for (const m of mailboxList(to)) {
    const addr = senderAddress(m);
    if (!addr || isOwn(sets, addr)) continue;
    const p: MailPriority = matchesList(sets.verder, addr) ? "verder"
      : matchesList(sets.creditorAddresses, addr) ? "creditor" : "other";
    if (RANK[p] > RANK[best]) best = p;
  }
  return best;
}

async function partyName(db: Db, id: string): Promise<string | null> {
  const [p] = await db.select({ name: schema.parties.name }).from(schema.parties).where(eq(schema.parties.id, id));
  return p?.name ?? null;
}

/** Who has been silent: the proposal's party, else the party or address of the
 *  newest inbound sender, else whom Martin wrote to. */
export async function counterpartyName(db: Db, sets: PrioritySets, who: Who | undefined): Promise<string> {
  if (!who) return "de andere kant";
  if (who.partyId) {
    const n = await partyName(db, who.partyId);
    if (n) return n;
  }
  const addrs: string[] = [];
  for (const from of who.inboundFrom) {
    const a = senderAddress(from);
    if (a) addrs.push(a);
  }
  for (const m of who.to ? mailboxList(who.to) : []) {
    const a = senderAddress(m);
    if (a && !isOwn(sets, a)) addrs.push(a);
  }
  for (const a of addrs) {
    const id = await resolveSenderPartyId(db, a);
    const n = id ? await partyName(db, id) : null;
    if (n) return n;
  }
  return addrs[0] ?? "de andere kant";
}

/** The follow-up that already chases this outbound message, if any. */
async function existingFollowUp(db: Db, t: ThreadState): Promise<string | null> {
  const col = t.lastOutbound.kind === "proposal"
    ? schema.proposals.parentProposalId : schema.proposals.triggerRawEmailId;
  const [p] = await db.select({ id: schema.proposals.id }).from(schema.proposals)
    .where(and(eq(schema.proposals.kind, "follow-up"), eq(col, t.lastOutbound.id))).limit(1);
  return p?.id ?? null;
}

async function chase(deps: ClockDeps, now: Date, errors: string[]): Promise<number> {
  const { db } = deps;
  const days = deps.followUpDays ?? followUpDays();
  const sets = await prioritySets(db);
  let chased = 0;
  for (const t of await threadStates(db, now, sets)) {
    if (!followUpDue(t, now, days)) continue;
    if (silentFor(t.lastOutboundAt, now) > FOLLOWUP_MAX_SILENCE_DAYS) continue;
    // One thread's failure (a context the kb lookup could not build) must not
    // keep the other threads from being chased.
    try { if (await chaseOne(deps, sets, t)) chased++; }
    catch (err) { errors.push(`${t.threadKey}: ${message(err)}`); }
  }
  return chased;
}

async function chaseOne(deps: ClockDeps, sets: PrioritySets, t: ThreadState): Promise<boolean> {
  const { db } = deps;
  const dedupKey = `followup:${t.threadKey}:${t.lastOutbound.kind}:${t.lastOutbound.id}`;
  // Created first, so the push can open it; a crash before the push leaves a
  // follow-up the next tick finds, and the push then still goes (once).
  const existing = await existingFollowUp(db, t);
  const proposalId = existing ?? await deps.createFollowUp(t);
  const [seen] = await db.select({ id: schema.notifications.id }).from(schema.notifications)
    .where(eq(schema.notifications.dedupKey, dedupKey)).limit(1);
  if (existing && seen) return false;
  const r = await deps.notify({
    kind: "follow-up", level: LEVEL[t.priority],
    title: `Nog geen antwoord van ${await counterpartyName(db, sets, t.who)} sinds ${dayMonth(t.lastOutboundAt)}`,
    body: "verder heeft een herinnering voor je klaargezet.",
    link: `verder://proposal/${proposalId}`, dedupKey,
  });
  return !existing || !r.duplicate;
}

/** The real `createFollowUp`: a `follow-up` proposal through `createProposal`. */
export function followUpCreator(deps: CreateDeps): (t: ThreadState) => Promise<string> {
  return async (t) => {
    const trigger = t.lastOutbound.kind === "proposal"
      ? { parentProposalId: t.lastOutbound.id } : { rawEmailId: t.lastOutbound.id };
    const { id } = await createProposal({ buildPrompt: buildProposalPrompt, ...deps }, trigger, t.priority, "follow-up");
    return id;
  };
}

// ---- 3. due within 24 h -------------------------------------------------------

/** Effective statuses that mean Martin is the one to act. */
const ON_MARTIN = new Set(["open", "in-progress"]);

async function dueTasks(deps: ClockDeps, now: Date): Promise<number> {
  const { db } = deps;
  const rows = await db.select({ id: schema.tasks.id, title: schema.tasks.title, dueAt: schema.tasks.dueAt })
    .from(schema.tasks)
    .where(and(isNotNull(schema.tasks.dueAt), lt(schema.tasks.dueAt, new Date(now.getTime() + DAY))));
  if (rows.length === 0) return 0;
  const statuses = await effectiveTaskStatuses(db, rows.map((r) => r.id));
  // The SQL window is a superset (a date-only deadline's UTC midnight is
  // before now + 24 h from the day before); dueAlert decides.
  const live = rows.filter((r) => ON_MARTIN.has(statuses.get(r.id) ?? "open") && dueAlert(r.dueAt!, now));
  if (live.length === 0) return 0;

  const keyOf = (r: (typeof live)[number]) => `due:${r.id}:${r.dueAt!.toISOString()}`;
  // One query instead of a notify per overdue task every quarter hour.
  const seen = new Set((await db.select({ k: schema.notifications.dedupKey }).from(schema.notifications)
    .where(inArray(schema.notifications.dedupKey, live.map(keyOf)))).map((r) => r.k));

  let alerted = 0;
  for (const r of live) {
    const dedupKey = keyOf(r);
    if (seen.has(dedupKey)) continue;
    const dueAt = r.dueAt!;
    const prefix = dueAlert(dueAt, now)!;
    const res = await deps.notify({
      kind: "task-due", level: "time-sensitive", title: `${prefix}: ${r.title}`,
      body: `Deadline ${dayMonth(dueAt)}.`, link: "verder://inbox", dedupKey,
    });
    if (!res.duplicate) alerted++;
  }
  return alerted;
}

// ---- the tick ----------------------------------------------------------------

export async function runClocks(deps: ClockDeps): Promise<ClockResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result: ClockResult = { reminded: 0, followUps: 0, due: 0 };
  if (!isAlertHour(now)) {
    // Night: nothing is due to anyone at 03:00. The row still goes, because
    // `proposal-clock` is a watcher and its silence would read as a dead worker.
    await recordRun(deps.db, PROPOSAL_CLOCK_WORKER_NAME, "ok", { ...result, quiet: true });
    return { ...result, quiet: true };
  }
  const errors: Record<string, string> = {};
  try { result.reminded = await remind(deps, now); } catch (err) { errors.reminder = message(err); }
  const threadErrors: string[] = [];
  try { result.followUps = await chase(deps, now, threadErrors); } catch (err) { threadErrors.push(message(err)); }
  if (threadErrors.length) errors.followUp = threadErrors.join("; ").slice(0, 2000);
  try { result.due = await dueTasks(deps, now); } catch (err) { errors.due = message(err); }
  const failed = Object.keys(errors).length > 0;
  await recordRun(deps.db, PROPOSAL_CLOCK_WORKER_NAME, failed ? "error" : "ok",
    failed ? { ...result, errors } : result);
  return result;
}
