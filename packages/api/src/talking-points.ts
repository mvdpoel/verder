import { dayKey } from "./amsterdam";

/**
 * TALKING POINTS FOR A CALL (Added 2026-11-03, Martin: "maybe show tips /
 * reminders to tell or ask about live while in the call, on screen in the
 * app").
 *
 * What the phone can and cannot know, measured online before this was built:
 * a third-party iOS app cannot record or hear a phone call at all; the Phone
 * app has its own call recording (More → "Gesprek opnemen", saved to Notes,
 * region- and language-dependent — Dutch availability unconfirmed); and
 * CXCallObserver tells an app THAT a call started or ended, never with whom or
 * what was said. So Grip cannot listen along. What it can do is put the
 * dossier in front of Martin: pick the party, read what to TELL them and what
 * to ASK them.
 *
 * DETERMINISTIC. Every point here is read off the dossier — no model is
 * involved — and every point names the record it came from, so Martin can
 * open it mid-call. The one AI sentence lives beside it (`briefSummary`),
 * labelled as AI and shown only once the host drafter has made it.
 *
 * PURE: no DB, no I/O. `loadTalkingPoints` (talking-points-load.ts) is the one
 * loader that feeds it; every membership rule that needs the database lives
 * there, and the few that can be checked here again (discarded and purged
 * documents) are checked here too, so a loader slip cannot put a thrown-away
 * document on the screen during a call.
 */

/** Never more than this many points per list: a call is not the time to read. */
export const MAX_POINTS = 6;
/** With no request from them on record, "since they last asked" is this window. */
export const TELL_WINDOW_DAYS = 30;
/** A mail silent longer than this is a closed matter (as the follow-up clock bounds it). */
export const UNANSWERED_MAX_DAYS = 30;
/** Younger than this, an unanswered mail may simply not be read yet: tell it, don't chase it. */
export const UNANSWERED_ASK_AFTER_HOURS = 48;
/** A point is a line on a phone, never a paragraph. */
export const POINT_TEXT_MAX = 140;

export type PointSourceType = "task" | "proposal" | "debt" | "mail" | "document" | "stop";

export interface TalkingPoint {
  /** Stable across loads: `<ask|tell>:<type>:<id>`. */
  id: string;
  /** Dutch, short. */
  text: string;
  source: { type: PointSourceType; id: string; link: string };
}

export interface TalkingPointsInput {
  now: Date;
  /** The newest mail FROM them (or their contact persons), if any. */
  lastRequestAt: Date | null;
  /** Tasks linked to the party, with their EFFECTIVE status and when it was set. */
  tasks: { id: string; title: string; status: string; statusAt: Date | null; dueAt: Date | null; createdAt: Date }[];
  /** What Martin sent them: a sent proposal, or his own outbound mail. */
  sent: { id: string; type: "proposal" | "mail"; subject: string; sentAt: Date; repliedAt: Date | null }[];
  /** Debts they are on (eiser, incasso, deurwaarder, gemachtigde, or the creditor). */
  debts: { id: string; creditorName: string; claimedCents: number | null; reference: string | null }[];
  /**
   * Documents Martin sent them (`sent`, `at` = when it went) or filed from
   * them (`filed`, `at` = when it was filed). `status` is the EFFECTIVE status.
   */
  documents: { id: string; title: string; at: Date; how: "sent" | "filed"; status: string; purged: boolean }[];
  /** Open stops on a spoor that concerns them. */
  openStops: { id: string; title: string; at: Date | null }[];
}

export interface TalkingPoints { tell: TalkingPoint[]; ask: TalkingPoint[] }

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

/** "5 nov", in Amsterdam. */
function dateLabel(d: Date): string {
  const [, m, day] = dayKey(d).split("-").map(Number);
  return `${day} ${MONTHS[m - 1]}`;
}

function short(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= POINT_TEXT_MAX ? t : `${t.slice(0, POINT_TEXT_MAX - 1).trimEnd()}…`;
}

/**
 * Where a point opens on the phone. The task, proposal and document screens
 * take an id; a debt, a mail and a stop have no screen of their own on the
 * phone yet, so they open the screen that lists them (`DeepLink.swift`
 * parses exactly these). `source.id` travels regardless, for when they do.
 */
function linkFor(type: PointSourceType, id: string): string {
  switch (type) {
    case "task": return `grip://task/${id}`;
    case "proposal": return `grip://proposal/${id}`;
    case "document": return `grip://document/${id}`;
    case "debt": case "mail": return "grip://dossier";
    case "stop": return "grip://timeline";
  }
}

function point(list: "ask" | "tell", type: PointSourceType, id: string, text: string): TalkingPoint {
  return { id: `${list}:${type}:${id}`, text: short(text), source: { type, id, link: linkFor(type, id) } };
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildTalkingPoints(input: TalkingPointsInput): TalkingPoints {
  const now = input.now.getTime();
  const windowStart = input.lastRequestAt?.getTime() ?? now - TELL_WINDOW_DAYS * DAY_MS;

  // ---- ASK: what Martin is waiting on them for. ------------------------------
  // 1. Tasks waiting on them, earliest deadline first, undated last.
  const waiting = input.tasks
    .filter((t) => t.status === "waiting")
    .sort((a, b) =>
      (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity)
      || a.createdAt.getTime() - b.createdAt.getTime() || byId(a, b))
    .map((t) => point("ask", "task", t.id,
      `Vraag naar: ${t.title}${t.dueAt ? ` (uiterlijk ${dateLabel(t.dueAt)})` : ""}`));

  // 2. Mail they have not answered: the longest silence first.
  const unanswered = input.sent.filter((s) => s.repliedAt === null && s.sentAt.getTime() >= now - UNANSWERED_MAX_DAYS * DAY_MS);
  const isChase = (s: { sentAt: Date }) => now - s.sentAt.getTime() >= UNANSWERED_ASK_AFTER_HOURS * HOUR_MS;
  const silences = unanswered.filter(isChase)
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || byId(a, b))
    .map((s) => point("ask", s.type, s.id, `Nog geen antwoord op je mail van ${dateLabel(s.sentAt)}: ${s.subject}`));

  // 3. A claim whose amount nobody stated. Unknown is unknown — never €0.
  const amounts = input.debts
    .filter((d) => d.claimedCents === null)
    .sort((a, b) => a.creditorName.localeCompare(b.creditorName, "nl") || byId(a, b))
    .map((d) => point("ask", "debt", d.id,
      `Vraag het gevorderde bedrag: ${d.creditorName}${d.reference ? ` (${d.reference})` : ""}`));

  // 4. Open stops on their spoor, newest first.
  const stops = [...input.openStops]
    .sort((a, b) => (b.at?.getTime() ?? -Infinity) - (a.at?.getTime() ?? -Infinity) || byId(a, b))
    .map((s) => point("ask", "stop", s.id, `Bespreek: ${s.title}`));

  const ask = [...waiting, ...silences, ...amounts, ...stops].slice(0, MAX_POINTS);

  // ---- TELL: what Martin did since they last asked, newest first. ------------
  type Dated = { at: number; p: TalkingPoint };
  const tell: Dated[] = [];
  for (const t of input.tasks) {
    if (t.status === "done" && t.statusAt && t.statusAt.getTime() >= windowStart) {
      tell.push({ at: t.statusAt.getTime(), p: point("tell", "task", t.id, `Gedaan: ${t.title}`) });
    }
  }
  // A mail too fresh to chase: say it is on its way. Once it is a chase it is an
  // ask instead, so a mail is never on both lists.
  for (const s of unanswered) {
    if (!isChase(s)) {
      tell.push({ at: s.sentAt.getTime(), p: point("tell", s.type, s.id, `Gemaild op ${dateLabel(s.sentAt)}: ${s.subject}`) });
    }
  }
  for (const d of input.documents) {
    // The effective status, re-checked: a discarded logo or a destroyed file
    // must never reach the screen, whatever the loader handed in.
    if (d.purged || d.status === "discarded" || d.at.getTime() < windowStart) continue;
    tell.push({ at: d.at.getTime(), p: point("tell", "document", d.id, d.how === "sent"
      ? `Opgestuurd op ${dateLabel(d.at)}: ${d.title}`
      : `Ontvangen en opgeborgen: ${d.title}`) });
  }
  const seen = new Set<string>();
  const tellPoints = tell
    .sort((a, b) => b.at - a.at || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0))
    .map((d) => d.p)
    // One document sent twice (two mails) is one point.
    .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
    .slice(0, MAX_POINTS);

  return { tell: tellPoints, ask };
}

export interface BriefRow {
  status: string;
  summary: string | null;
  model: string | null;
  promptVersion: string | null;
  generatedAt: Date | null;
  sourceRefs: { type: "mail" | "task" | "debt"; id: string }[];
}

export interface BriefSummary {
  text: string;
  model: string | null;
  promptVersion: string | null;
  generatedAt: string;
  sourceRefs: { type: "mail" | "task" | "debt"; id: string }[];
  /** Always true: the one line on this screen a model wrote. */
  ai: true;
  label: "Samenvatting door AI";
}

/**
 * The AI line, ONLY when the drafter's answer passed the store step
 * (`status = 'ready'`). Pending, drafting and failed show nothing — never a
 * placeholder that reads like a fact, and never a previous summary that a newer
 * mail has made stale (re-marking a party pending is what hides it).
 */
export function briefSummary(row: BriefRow | null): BriefSummary | null {
  if (!row || row.status !== "ready" || !row.summary || !row.generatedAt) return null;
  return {
    text: row.summary, model: row.model, promptVersion: row.promptVersion,
    generatedAt: row.generatedAt.toISOString(), sourceRefs: row.sourceRefs,
    ai: true, label: "Samenvatting door AI",
  };
}
