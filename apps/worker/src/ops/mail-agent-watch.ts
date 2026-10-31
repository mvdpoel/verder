// The mail agent's watcher (Plan 2 Task 20, spec §6.5 "the mail agent folds in"):
//
//   ops/mail-agent.sh:  { watchlist; seen ids as `seen:<id>` } | pnpm --silent --filter worker mail-agent-watch
//
// Replaces the homelab's gwatch.mts. It reads Martin's WATCHLIST (Statiegeld
// Nederland, Bungas, Tikkie, Hanneke — senders the dossier does NOT ingest) from
// STDIN, because the worker has no mount for /mnt/data/verder/mail-agent and
// stdin needs no compose change, asks Gmail READ-ONLY for their recent mail, and
// prints one JSON line per new thread. The host script hands each line to
// `proposals-store --external`, which makes a `drafting` proposal of it; the host
// drafter drafts it; Martin approves it on the phone. Nothing here sends, writes
// a proposal, or touches the dossier.
//
// THE GUARDS, each with the failure it prevents:
//   - FAILS CLOSED on an empty watchlist: zero usable addresses records
//     `mail-agent` error {reason: "empty-watchlist"} and makes NO Gmail call. An
//     empty `from:()` is the whole mailbox.
//   - The sender is re-checked IN PROCESS with the strict `senderAddress`, never
//     a substring of the header: Gmail's `from:` search matches display names
//     too, so `"x@bungas.nl" <attacker@evil.tld>` comes back from the query, and
//     the external context ADMITS the sender as a legal recipient.
//   - SKIPS what ingest already handles (`isRelevantMessage`, the same predicate
//     `pollGmail` uses): `verderbewindmidden.nl` is on both lists today, so every
//     Verder mail would otherwise get two proposals.
//   - SKIPS seen ids BEFORE fetching (seen.txt, from the host), ids ingest has
//     already stored (`raw_emails`), and ids that already have an external
//     proposal — as its trigger OR as an earlier message in its `thread[]`, so a
//     lost seen.txt append cannot re-fetch a thread's older mail and make a
//     second proposal with one of them as the trigger.
//   - NEVER RE-FETCHES A SKIP: a message fetched and then dropped (relevant, or
//     not on the watchlist) is printed as a `seen <id>` line, which the host
//     appends to seen.txt. Without it every such message inside the 3-day window
//     was fetched in full every run — the burn pattern `pollGmail` once had —
//     and, list order being newest first, twenty of them ahead of a real
//     watchlist mail pushed that mail into `deferred` on every run until it fell
//     out of the window.
//   - SHARES the Gmail rate-limit memory: a live `rateLimitedUntil` deadline from
//     ANY path skips the run (recorded `ok`, carrying the instant forward), and a
//     429 here is persisted on this name's row, where every other path reads it.
//     A row written while a deadline is live CARRIES it forward (the empty-
//     watchlist error included), because `rateLimitedUntil` reads only the
//     newest row per name.
//   - BOUNDED: at most MAX_FETCH_PER_RUN `messages.get` calls per run, at the
//     old agent's own cadence, so no new Gmail load.
//
// stdout is one JSON line per thread plus `seen <id>` lines; it prints ONLY the
// listed fields. No token, no raw header block, no raw bytes:
// stdout goes into the host's cron log and into a proposal row.
import { inArray, sql } from "drizzle-orm";
import { google } from "googleapis";
import { createDb, schema, type Db } from "@verder/db";
import { MAIL_AGENT_WORKER_NAME } from "@verder/api/src/worker-names";
import { recordRun } from "../heartbeat";
import { rateLimitedUntil, senderAddress } from "../gmail";
import { listAllMessageIds, oauthClient } from "../gmail-auth";
import { isInlineBodyImage } from "../gmail-parts";
import { matchesList } from "../mail/priority";
import {
  isRelevantMessage, ownMailboxAddresses, relevantAddresses, sanitizeAddresses, type RejectedAddress,
} from "../mail/relevance";
import { closeNotify } from "../notify/notify";
import { rateLimitDeadline } from "../proposals/send";
import type { ExternalAttachment, ExternalMail, ExternalThreadMail } from "../proposals/context";

/** The old agent's window. */
export const WATCH_WINDOW = "newer_than:3d";
/** Characters of a trigger body printed; matches the proposal context's cap. */
export const WATCH_BODY_CHARS = 6000;
/** Characters of an earlier message in the thread. */
export const WATCH_THREAD_BODY_CHARS = 2000;
/** `messages.get` calls per run, at most. The rest waits for the next run. */
export const MAX_FETCH_PER_RUN = 20;
const QUERY_MAX = 1500;
const GMAIL_ID = /^[0-9a-zA-Z_-]{1,64}$/;

export interface WatchMessage {
  id: string; threadId: string; messageId: string | null;
  from: string; to: string; subject: string; date: Date;
  /** Plain text: text/plain, else the HTML part with its markup stripped. */
  body: string;
  attachments: ExternalAttachment[];
}

export interface WatchPort {
  listMessageIds(query: string): Promise<string[]>;
  getMessage(id: string): Promise<WatchMessage>;
}

export interface WatchInput { addrs: string[]; rejected: RejectedAddress[]; seen: Set<string> }

/**
 * The host's stdin: the watchlist file, then seen.txt with each line prefixed
 * `seen:`. A watchlist line is an address or an `@domain` (a bare `domain.tld`
 * is read as `@domain.tld`, and a leading `from:` is dropped); `#` starts a
 * comment. Anything else is REJECTED with a reason, never guessed at — a name
 * like `Hanneke` is not an address.
 */
export function parseWatchInput(text: string): WatchInput {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("seen:")) {
      const id = line.slice(5).trim();
      if (GMAIL_ID.test(id)) seen.add(id);
      continue;
    }
    let v = line.replace(/#.*$/, "").trim();
    if (!v) continue;
    v = v.replace(/^from:\s*/i, "");
    if (!v.includes("@") && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(v)) v = `@${v}`;
    entries.push(v);
  }
  // "operator": a human wrote this file, so a whole domain is a legal entry —
  // and Martin's own mailbox is refused, because it is on every message.
  const { addrs, rejected } = sanitizeAddresses(entries, ownMailboxAddresses(), "operator");
  return { addrs, rejected, seen };
}

/** `from:(a OR b) newer_than:3d`, chunked like `buildQueries`. No addresses, NO query. */
export function watchQueries(addrs: string[], window = WATCH_WINDOW): string[] {
  if (addrs.length === 0) return [];
  const render = (c: string[]) => `from:(${c.map((a) => a.replace(/^@/, "")).join(" OR ")}) ${window}`;
  const out: string[] = [];
  let chunk: string[] = [];
  for (const a of addrs) {
    if (chunk.length && render([...chunk, a]).length > QUERY_MAX) { out.push(render(chunk)); chunk = [a]; }
    else chunk.push(a);
  }
  if (chunk.length) out.push(render(chunk));
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML to readable text: no markup, no script or style, entities decoded. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One printed line: EXACTLY these fields, built field by field so nothing the
 *  port carries beyond them can ever reach stdout. */
export function toExternal(m: WatchMessage, earlier: WatchMessage[]): ExternalMail {
  const thread: ExternalThreadMail[] = earlier.map((t) => ({
    gmailId: t.id, from: t.from, subject: t.subject, date: t.date.toISOString(),
    body: clip(t.body, WATCH_THREAD_BODY_CHARS),
  }));
  return {
    gmailId: m.id, threadId: m.threadId, messageId: m.messageId,
    from: m.from, to: m.to, subject: m.subject, date: m.date.toISOString(),
    body: clip(m.body, WATCH_BODY_CHARS),
    attachments: m.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size })),
    thread,
  };
}

export interface WatchDeps {
  db: Db;
  /** Built only once the run knows it will call Gmail. */
  port: () => Promise<WatchPort>;
  input: string;
  now?: () => Date;
}

export interface WatchResult {
  status: "ok" | "error" | "skipped";
  lines: ExternalMail[];
  /** Fetched and deliberately dropped: the host marks these seen, so they are
   *  never fetched again. A message that FAILED to fetch is not in here. */
  skipped: string[];
  detail: Record<string, unknown>;
}

/** Gmail ids an external proposal already covers: its trigger, or any earlier
 *  message carried in its `thread[]`. */
async function knownExternal(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const res = await db.execute<{ id: string }>(sql`
    SELECT p.trigger_external->>'gmailId' AS id FROM proposals p
     WHERE p.trigger_external->>'gmailId' IN (${list})
    UNION
    SELECT t->>'gmailId' FROM proposals p
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(p.trigger_external->'thread') = 'array'
            THEN p.trigger_external->'thread' ELSE '[]'::jsonb END) t
     WHERE p.trigger_external IS NOT NULL AND t->>'gmailId' IN (${list})`);
  return new Set(res.rows.map((r) => r.id));
}

/** Gmail ids ingest has already stored: relevant by definition, never fetched. */
async function ingested(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.select({ id: schema.rawEmails.gmailMessageId }).from(schema.rawEmails)
    .where(inArray(schema.rawEmails.gmailMessageId, ids));
  return new Set(rows.map((r) => r.id));
}

export async function watchMail(deps: WatchDeps): Promise<WatchResult> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const { addrs, rejected, seen } = parseWatchInput(deps.input);

  // One account, one user-rate limit: a deadline ANY path recorded holds here.
  const until = await rateLimitedUntil(db, now());

  // Fail closed BEFORE anything else: no list, no query, no Gmail call. The
  // live deadline rides along, or this row would erase a 429 that only this
  // name remembered.
  if (addrs.length === 0) {
    const detail = { reason: "empty-watchlist", rejected, ...(until ? { retryAfter: until.toISOString() } : {}) };
    await recordRun(db, MAIL_AGENT_WORKER_NAME, "error", detail);
    return { status: "error", lines: [], skipped: [], detail };
  }

  if (until) {
    const detail = { skipped: "rate-limited", retryAfter: until.toISOString() };
    await recordRun(db, MAIL_AGENT_WORKER_NAME, "ok", detail);
    return { status: "skipped", lines: [], skipped: [], detail };
  }

  const counts = {
    listed: 0, fetched: 0, seen: 0, ingested: 0, known: 0, relevant: 0, notOnWatchlist: 0, deferred: 0,
  };
  const skipped: string[] = [];
  const failures: { id: string; message: string }[] = [];
  try {
    const port = await deps.port();
    const relevant = await relevantAddresses(db);
    const ids: string[] = [];
    const listed = new Set<string>();
    for (const q of watchQueries(addrs)) {
      for (const id of await port.listMessageIds(q)) {
        if (!listed.has(id)) { listed.add(id); ids.push(id); }
      }
    }
    counts.listed = ids.length;
    const fresh = ids.filter((id) => { if (seen.has(id)) { counts.seen++; return false; } return true; });
    const stored = await ingested(db, fresh);
    const known = await knownExternal(db, fresh);
    const todo = fresh.filter((id) => {
      if (stored.has(id)) { counts.ingested++; return false; }
      if (known.has(id)) { counts.known++; return false; }
      return true;
    });

    const kept: WatchMessage[] = [];
    for (const id of todo) {
      if (counts.fetched >= MAX_FETCH_PER_RUN) { counts.deferred++; continue; }
      let m: WatchMessage;
      counts.fetched++;
      try { m = await port.getMessage(id); }
      catch (err) {
        // A rate limit ends the run (and is persisted below); anything else is
        // this message's problem only.
        if (rateLimitDeadline(err, now())) throw err;
        failures.push({ id, message: String(err).slice(0, 300) });
        continue;
      }
      const sender = senderAddress(m.from);
      if (!sender || !matchesList(addrs, sender)) { counts.notOnWatchlist++; skipped.push(id); continue; }
      if (isRelevantMessage(relevant, m)) { counts.relevant++; skipped.push(id); continue; }
      kept.push(m);
    }

    // One line per THREAD: its newest new message is the trigger, the earlier
    // new ones its context — one reply answers the conversation, not each mail.
    const byThread = new Map<string, WatchMessage[]>();
    for (const m of kept) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
    const lines: ExternalMail[] = [];
    for (const msgs of byThread.values()) {
      msgs.sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id));
      const newest = msgs[msgs.length - 1];
      lines.push(toExternal(newest, msgs.slice(0, -1)));
    }
    lines.sort((a, b) => a.date.localeCompare(b.date));

    const detail = { ...counts, emitted: lines.length, failures, rejected };
    await recordRun(db, MAIL_AGENT_WORKER_NAME, failures.length ? "error" : "ok", detail);
    return { status: failures.length ? "error" : "ok", lines, skipped, detail };
  } catch (err) {
    // Persisted where `rateLimitedUntil` reads it, so the poller, the send job
    // and the next run all wait it out instead of re-arming the lockout.
    const retryAfter = rateLimitDeadline(err, now());
    const detail = {
      ...counts, message: String(err).slice(0, 500),
      ...(retryAfter ? { retryAfter: retryAfter.toISOString() } : {}),
    };
    await recordRun(db, MAIL_AGENT_WORKER_NAME, "error", detail);
    // What was already fetched and dropped is still marked seen.
    return { status: "error", lines: [], skipped, detail };
  }
}

// ---- the real, READ-ONLY port --------------------------------------------------

interface Part {
  filename?: string | null; mimeType?: string | null;
  body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
  parts?: Part[] | null;
}

function firstBody(p: Part | undefined | null, mime: string): string | null {
  if (!p) return null;
  if (p.mimeType === mime && !p.filename && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const c of p.parts ?? []) { const r = firstBody(c, mime); if (r) return r; }
  return null;
}

/** The text a human would read. Exported for its test. */
export function bodyOf(payload: Part | undefined | null): string {
  const plain = firstBody(payload, "text/plain");
  if (plain) return plain;
  const html = firstBody(payload, "text/html");
  return html ? stripHtml(html) : "";
}

/** Attachments by name, mime and size; an image the HTML body embeds is not one. */
export function attachmentsOf(payload: Part | undefined | null): ExternalAttachment[] {
  const out: ExternalAttachment[] = [];
  const walk = (p: Part) => {
    for (const c of p.parts ?? []) {
      if (c.filename && c.body?.attachmentId && !isInlineBodyImage(c)) {
        out.push({ filename: c.filename, mime: c.mimeType ?? "application/octet-stream", size: c.body.size ?? 0 });
      }
      if (c.parts) walk(c);
    }
  };
  if (payload) walk(payload);
  return out;
}

/** Read-only: the ingest client (`oauthClient`, gmail.readonly). One
 *  `messages.get` (format=full) per message; attachment bytes are never fetched. */
export async function realWatchPort(): Promise<WatchPort> {
  const gmail = google.gmail({ version: "v1", auth: await oauthClient() });
  return {
    listMessageIds: (q) => listAllMessageIds((params) => gmail.users.messages.list(params), q),
    async getMessage(id) {
      const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const payload = res.data.payload as Part | undefined;
      const h = new Map((payload?.headers ?? []).map((x) => [(x.name ?? "").toLowerCase(), x.value ?? ""]));
      return {
        id, threadId: res.data.threadId ?? "", messageId: h.get("message-id")?.trim() || null,
        from: h.get("from") ?? "", to: h.get("to") ?? "", subject: h.get("subject") ?? "(geen onderwerp)",
        date: new Date(Number(res.data.internalDate ?? 0)),
        body: bodyOf(payload), attachments: attachmentsOf(payload),
      };
    },
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.WORKER_DATABASE_URL
    ?? "postgres://verder_worker:verder_worker@localhost:5432/verder";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const { db, pool } = createDb(url);
  let cached: Promise<WatchPort> | null = null;
  try {
    const r = await watchMail({
      db, input: Buffer.concat(chunks).toString("utf8"),
      port: () => (cached ??= realWatchPort()),
    });
    for (const line of r.lines) process.stdout.write(`${JSON.stringify(line)}\n`);
    // Fetched and dropped: ops/mail-agent.sh appends these to seen.txt.
    for (const id of r.skipped) process.stdout.write(`seen ${id}\n`);
    // The summary goes to stderr, so stdout holds only JSON lines and `seen` lines.
    console.error(`mail-agent-watch: ${r.status} ${JSON.stringify({ ...r.detail, rejected: undefined, failures: undefined })}`);
    if (r.status === "error") process.exitCode = 1;
  } catch (err) {
    console.error(`mail-agent-watch: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    // One-shot: an open APNs HTTP/2 session would keep the process alive.
    await closeNotify();
    await pool.end();
  }
}
