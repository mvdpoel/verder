import { readFile } from "node:fs/promises";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@grip/db";
import {
  effectiveDocTypeSql, effectivePartyIdSql, effectiveTitleSql, notDiscardedSql, notPurgedSql,
} from "@grip/api/src/effective-status";
import { readFilePath } from "@grip/api/src/storage";
import { retrieve } from "@grip/api/src/search/retrieve";
import type { EmbedPort } from "@grip/api/src/search/embed";
import type { SearchEntityType } from "@grip/core";
import { effectiveTaskStatuses } from "@grip/api/src/task-decide";
import { loadTrackMapRows } from "@grip/api/src/routers/tracks";
import { buildTrackMap } from "@grip/api/src/track-map";
import { rateLimitedUntil } from "../gmail";
import { headerFields, replySubject } from "../mail/threading";
import type { GmailReadPort } from "./gmail-read";
import { GMAIL_SEARCH_MAX } from "./gmail-read";
import { addressesOf, clip, euro, iso, page, plainBody } from "./output";

/**
 * THE READ-ONLY TOOLS OF `grip-tools` (Vraag Grip spec, "The tools").
 *
 * Each tool is a plain function of a READ ONLY transaction (`runReadOnly`, the
 * server enforces it, never the tool) and its validated arguments. It returns
 * compact JSON in the one convention `output.ts` reads ids from: every entity
 * is an object with `type` and `id`, every address sits in an `addresses` list.
 *
 * Documents are read through the effective status, title, soort and party
 * (`effective-status.ts`); discarded and purged documents are never returned.
 * Gmail is read live through a `gmail.readonly` token, and its rate-limit
 * memory (`rateLimitedUntil`) is honoured: during a lockout the Gmail tools
 * answer "unavailable" without calling Google.
 */

export interface ToolEnv {
  /** A READ ONLY transaction. */
  db: Db;
  embed: EmbedPort;
  gmail: () => Promise<GmailReadPort | null>;
  vaultDir: string;
  now: () => Date;
}

export interface ToolResult {
  data: Record<string, unknown>;
  /** gmail_read only: what requests-store needs to reply to that message. */
  mail?: {
    gmailId: string; threadId: string; messageId: string | null; references: string[];
    from: string; to: string; subject: string; date: string; body: string;
  };
}

/** Thrown by a Gmail tool on a 429 so the server can record the deadline. */
export class GmailRateLimited extends Error {
  constructor(readonly original: unknown) { super("gmail rate limited"); }
}

export interface ToolDef<A extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  args: A;
  run(env: ToolEnv, args: z.infer<A>): Promise<ToolResult>;
}

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt);
const offset = z.number().int().min(0).max(10_000_000).default(0).describe("character offset of the next page");
const words = z.string().trim().min(1).max(200);

/** `%` and `_` are characters the model meant, not wildcards. */
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const rows = async <T>(db: Db, q: SQL): Promise<T[]> => (await db.execute(q)).rows as T[];
const amsterdamDay = (col: SQL) => sql`(${col} AT TIME ZONE 'Europe/Amsterdam')::date`;
const and = (parts: SQL[]): SQL => parts.length ? sql.join(parts, sql` AND `) : sql`TRUE`;

const SEARCH_TYPES = ["document", "mail", "entry", "debt", "task", "stop", "track", "party", "financial_item"] as const;
const toIndexType = (t: string): SearchEntityType => (t === "mail" ? "email" : t) as SearchEntityType;
const fromIndexType = (t: string): string => (t === "email" ? "mail" : t);

// ---- the dossier --------------------------------------------------------------

const search: ToolDef = {
  name: "search",
  description: "Hybrid search (keywords + meaning) over the whole dossier: documents, mail, logbook entries, debts, tasks, map stops, parties, fixed costs. Start here when you do not know where something is.",
  args: z.object({
    query: words.describe("what to look for, in Dutch words"),
    types: z.array(z.enum(SEARCH_TYPES)).max(9).optional().describe("restrict to these kinds"),
    limit: limit(10, 8),
  }).strict(),
  async run(env, a) {
    const r = await retrieve({ db: env.db, embed: env.embed },
      { q: a.query, mode: "fast", limit: a.limit, entityTypes: a.types?.map(toIndexType) });
    return { data: {
      semantic: r.semanticAvailable,
      items: r.hits.map((h) => ({ type: fromIndexType(h.entityType), id: h.entityId, title: h.title,
        date: h.occurredAt, status: h.status, snippet: clip(h.snippet, 300) })),
    } };
  },
};

interface DocRow {
  id: string; title: string; soort: string | null; party_id: string | null; party: string | null;
  received_at: string; mime: string; source: string; size_bytes: number;
}
const docColumns = sql`documents.id, ${effectiveTitleSql} AS title, ${effectiveDocTypeSql} AS soort,
  ${effectivePartyIdSql} AS party_id,
  (SELECT p.name FROM parties p WHERE p.id = ${effectivePartyIdSql}) AS party,
  documents.received_at, documents.mime, documents.source, documents.size_bytes`;
const docItem = (d: DocRow) => ({
  type: "document", id: d.id, title: d.title, soort: d.soort,
  party: d.party_id ? { type: "party", id: d.party_id, name: d.party } : null,
  received: iso(d.received_at), mime: d.mime, source: d.source, sizeKb: Math.ceil(Number(d.size_bytes) / 1024),
});

const getDocument: ToolDef = {
  name: "get_document",
  description: "One document from the vault: effective title, soort, sender party, received date and its extracted text (paged; pass nextOffset as offset for more). Discarded or purged documents are not available.",
  args: z.object({ id: uuid, offset }).strict(),
  async run(env, a) {
    const [d] = await rows<DocRow>(env.db, sql`SELECT ${docColumns} FROM documents
      WHERE documents.id = ${a.id} AND ${notDiscardedSql} AND ${notPurgedSql}`);
    if (!d) return { data: { error: "Dit document bestaat niet, of is weggegooid of vernietigd." } };
    const [t] = await rows<{ text: string; extractor: string }>(env.db,
      sql`SELECT text, extractor FROM document_texts WHERE document_id = ${a.id}`);
    return { data: {
      document: docItem(d),
      extractor: t?.extractor ?? null,
      ...(t?.text ? page(t.text, a.offset) : { text: null, note: "Geen tekst uit dit document gehaald." }),
    } };
  },
};

const listDocuments: ToolDef = {
  name: "list_documents",
  description: "Documents in the vault, newest first, filtered by soort (e.g. loonstrook, beschikking, bank-statement), sender party, received period, source (email-attachment, nas-scan, upload, phone-scan, loondossier, ...) or words in the title.",
  args: z.object({
    soort: z.string().trim().min(1).max(60).optional(),
    partyId: uuid.optional(),
    from: day.optional(), to: day.optional(),
    source: z.string().trim().min(1).max(40).optional(),
    title: words.optional(),
    limit: limit(40, 20),
  }).strict(),
  async run(env, a) {
    const where: SQL[] = [notDiscardedSql, notPurgedSql];
    if (a.soort) where.push(sql`${effectiveDocTypeSql} ILIKE ${like(a.soort)}`);
    if (a.partyId) where.push(sql`${effectivePartyIdSql} = ${a.partyId}::uuid`);
    if (a.from) where.push(sql`${amsterdamDay(sql`documents.received_at`)} >= ${a.from}::date`);
    if (a.to) where.push(sql`${amsterdamDay(sql`documents.received_at`)} <= ${a.to}::date`);
    if (a.source) where.push(sql`documents.source::text = ${a.source}`);
    if (a.title) where.push(sql`${effectiveTitleSql} ILIKE ${like(a.title)}`);
    const docs = await rows<DocRow>(env.db, sql`SELECT ${docColumns} FROM documents WHERE ${and(where)}
      ORDER BY documents.received_at DESC, documents.id LIMIT ${a.limit}`);
    return { data: { items: docs.map(docItem) } };
  },
};

interface MailRow {
  id: string; gmail_message_id: string; from_addr: string; to_addr: string; subject: string;
  sent_at: string; body_text: string; raw_rfc822_sha256: string; source: string;
}

const getMail: ToolDef = {
  name: "get_mail",
  description: "One mail in Grip's dossier (raw_emails): from, to, cc, date, subject, replySubject, body (HTML stripped, paged) and its attachments as document ids. Read a mail with this before replying to it.",
  args: z.object({ id: uuid, offset }).strict(),
  async run(env, a) {
    const [m] = await rows<MailRow>(env.db, sql`SELECT id, gmail_message_id, from_addr, to_addr, subject,
      sent_at, body_text, raw_rfc822_sha256, source FROM raw_emails WHERE id = ${a.id}`);
    if (!m) return { data: { error: "Deze mail bestaat niet." } };
    let cc = "";
    try {
      const raw = await readFile(readFilePath(env.vaultDir, m.raw_rfc822_sha256));
      cc = (headerFields(raw) ?? []).filter((f) => f.name === "cc").map((f) => f.value).join(", ");
    } catch { /* the raw bytes are not readable here: no cc */ }
    const atts = await rows<DocRow>(env.db, sql`SELECT ${docColumns} FROM documents
      WHERE documents.source = 'email-attachment' AND documents.source_ref = ${m.gmail_message_id}
        AND ${notDiscardedSql} AND ${notPurgedSql} ORDER BY documents.created_at, documents.id`);
    return { data: {
      mail: { type: "mail", id: m.id, from: m.from_addr, to: m.to_addr, cc: cc || null, date: iso(m.sent_at),
        subject: m.subject, replySubject: replySubject(m.subject),
        addresses: addressesOf(m.from_addr, m.to_addr, cc) },
      attachments: atts.map(docItem),
      body: page(plainBody(m.body_text), a.offset),
    } };
  },
};

const listMail: ToolDef = {
  name: "list_mail",
  description: "Mail in Grip's dossier, newest first, by party (its address and its contact persons'), by address, by period or by words in the subject. Headers only; read one with get_mail.",
  args: z.object({
    partyId: uuid.optional(),
    address: z.string().trim().min(3).max(200).optional().describe("part of an address or domain"),
    from: day.optional(), to: day.optional(),
    subject: words.optional(),
    limit: limit(40, 20),
  }).strict(),
  async run(env, a) {
    const where: SQL[] = [];
    if (a.partyId) {
      const emails = (await rows<{ email: string }>(env.db, sql`SELECT lower(email) AS email FROM parties
        WHERE (id = ${a.partyId}::uuid OR parent_party_id = ${a.partyId}::uuid) AND email IS NOT NULL AND email <> ''`))
        .map((r) => r.email);
      if (emails.length === 0) return { data: { items: [], note: "Deze partij heeft geen e-mailadres in het dossier." } };
      where.push(sql`(${sql.join(emails.map((e) => sql`(from_addr ILIKE ${like(e)} OR to_addr ILIKE ${like(e)})`), sql` OR `)})`);
    }
    if (a.address) where.push(sql`(from_addr ILIKE ${like(a.address)} OR to_addr ILIKE ${like(a.address)})`);
    if (a.from) where.push(sql`${amsterdamDay(sql`sent_at`)} >= ${a.from}::date`);
    if (a.to) where.push(sql`${amsterdamDay(sql`sent_at`)} <= ${a.to}::date`);
    if (a.subject) where.push(sql`subject ILIKE ${like(a.subject)}`);
    const mails = await rows<MailRow>(env.db, sql`SELECT id, from_addr, to_addr, subject, sent_at FROM raw_emails
      WHERE ${and(where)} ORDER BY sent_at DESC, id LIMIT ${a.limit}`);
    return { data: { items: mails.map((m) => ({ type: "mail", id: m.id, from: m.from_addr, to: clip(m.to_addr, 200),
      date: iso(m.sent_at), subject: m.subject, addresses: addressesOf(m.from_addr, m.to_addr) })) } };
  },
};

// ---- live Gmail -----------------------------------------------------------------

async function gmailOrWhy(env: ToolEnv): Promise<GmailReadPort | string> {
  const until = await rateLimitedUntil(env.db, env.now());
  if (until) return `Gmail is tijdelijk niet beschikbaar (limiet van Google tot ${until.toISOString()}). Antwoord zonder Gmail en zeg dat.`;
  const port = await env.gmail();
  return port ?? "Gmail is niet ingesteld op deze server. Antwoord zonder Gmail en zeg dat.";
}

const isRateLimit = (err: unknown): boolean => {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  return /Retry after|rate limit/i.test(String(err)) || [e?.code, e?.status, e?.response?.status].includes(429);
};

const gmailSearch: ToolDef = {
  name: "gmail_search",
  description: `LIVE search of Martin's Gmail with Gmail query syntax (from:, to:, subject:, after:YYYY/MM/DD, newer_than:30d, has:attachment, words). Headers and a snippet only, at most ${GMAIL_SEARCH_MAX}. Gmail is wider than the dossier and holds unrelated business mail; it is never ingested by this. At most 10 searches per request.`,
  args: z.object({ query: z.string().trim().min(1).max(500), max: limit(GMAIL_SEARCH_MAX, 10) }).strict(),
  async run(env, a) {
    const port = await gmailOrWhy(env);
    if (typeof port === "string") return { data: { unavailable: port } };
    try {
      const found = await port.search(a.query, a.max);
      return { data: { items: found.map((m) => ({ type: "gmail", id: m.gmailId, threadId: m.threadId, from: m.from,
        to: clip(m.to, 200), date: m.date, subject: m.subject, snippet: clip(m.snippet, 200),
        addresses: addressesOf(m.from, m.to) })) } };
    } catch (err) {
      if (isRateLimit(err)) throw new GmailRateLimited(err);
      throw err;
    }
  },
};

const gmailRead: ToolDef = {
  name: "gmail_read",
  description: "One LIVE Gmail message by id (from gmail_search): headers, the text body (paged) and attachment names (their bytes are never fetched). Read a Gmail message with this before replying to it. At most 20 reads per request.",
  args: z.object({ id: z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/), offset }).strict(),
  async run(env, a) {
    const port = await gmailOrWhy(env);
    if (typeof port === "string") return { data: { unavailable: port } };
    let m;
    try { m = await port.read(a.id); } catch (err) {
      if (isRateLimit(err)) throw new GmailRateLimited(err);
      throw err;
    }
    const body = plainBody(m.body);
    return {
      data: {
        gmail: { type: "gmail", id: m.gmailId, threadId: m.threadId, from: m.from, to: m.to, cc: m.cc || null,
          date: m.date, subject: m.subject, replySubject: replySubject(m.subject),
          addresses: addressesOf(m.from, m.to, m.cc) },
        attachments: m.attachments.map((x) => ({ filename: x.filename, mime: x.mime, sizeKb: Math.ceil(x.size / 1024),
          note: "niet in het dossier; kan niet worden bijgevoegd" })),
        body: page(body, a.offset),
      },
      mail: { gmailId: m.gmailId, threadId: m.threadId, messageId: m.messageId, references: m.references,
        from: m.from, to: m.to, subject: m.subject, date: m.date, body: body.slice(0, 6000) },
    };
  },
};

// ---- money ------------------------------------------------------------------------

const listTransactions: ToolDef = {
  name: "list_transactions",
  description: "Bank rows from imported statements, newest first (amounts are signed: debits negative). Filter by own account IBAN, period, counterparty (name or IBAN), amount range in cents, or words in the description (e.g. a mandate, 'incasso').",
  args: z.object({
    account: z.string().trim().min(4).max(40).optional(),
    from: day.optional(), to: day.optional(),
    counterparty: words.optional(),
    description: words.optional(),
    minCents: z.number().int().optional(), maxCents: z.number().int().optional(),
    limit: limit(60, 30),
  }).strict(),
  async run(env, a) {
    const where: SQL[] = [sql`parse_error = false`];
    if (a.account) where.push(sql`replace(account_iban, ' ', '') ILIKE ${like(a.account.replace(/\s+/g, ""))}`);
    if (a.from) where.push(sql`${amsterdamDay(sql`booked_at`)} >= ${a.from}::date`);
    if (a.to) where.push(sql`${amsterdamDay(sql`booked_at`)} <= ${a.to}::date`);
    if (a.counterparty) where.push(sql`(counterparty_name ILIKE ${like(a.counterparty)} OR counterparty_iban ILIKE ${like(a.counterparty)})`);
    if (a.description) where.push(sql`description ILIKE ${like(a.description)}`);
    if (a.minCents !== undefined) where.push(sql`amount_cents >= ${a.minCents}`);
    if (a.maxCents !== undefined) where.push(sql`amount_cents <= ${a.maxCents}`);
    const tx = await rows<{ id: string; booked_at: string; amount_cents: number; counterparty_name: string | null;
      counterparty_iban: string | null; description: string | null; account_iban: string | null; mandate_id: string | null }>(
      env.db, sql`SELECT id, booked_at, amount_cents, counterparty_name, counterparty_iban, description, account_iban, mandate_id
        FROM transactions WHERE ${and(where)} ORDER BY booked_at DESC, id LIMIT ${a.limit}`);
    const [count] = await rows<{ n: number }>(env.db, sql`SELECT count(*)::int AS n FROM transactions WHERE parse_error = false`);
    return { data: {
      ...(count.n === 0 ? { note: "Er zijn nog geen bankafschriften geïmporteerd." } : {}),
      items: tx.map((t) => ({ type: "transaction", id: t.id, date: iso(t.booked_at), amount: euro(t.amount_cents),
        amountCents: t.amount_cents, counterparty: t.counterparty_name, counterpartyIban: t.counterparty_iban,
        description: clip(t.description, 200), mandate: t.mandate_id, account: t.account_iban })),
    } };
  },
};

// ---- parties, debts, the case -------------------------------------------------------

interface PartyRow { id: string; kind: string; name: string; organization: string | null; email: string | null; parent_party_id: string | null }
const partyItem = (p: PartyRow) => ({ type: "party", id: p.id, name: p.name, kind: p.kind, organization: p.organization,
  email: p.email, addresses: p.email ? addressesOf(p.email) : [] });

async function debtsWhere(db: Db, where: SQL): Promise<Record<string, unknown>[]> {
  const debts = await rows<{ id: string; creditor_name: string; creditor_party_id: string | null; claimed_cents: number | null;
    principal_cents: number | null; references: string | null; reported_to_verder_at: string | null }>(db, sql`
    SELECT d.id, d.creditor_name, d.creditor_party_id, d.claimed_cents, d.principal_cents, d."references",
      d.reported_to_verder_at FROM debts d WHERE ${where} ORDER BY d.created_at, d.id LIMIT 60`);
  if (debts.length === 0) return [];
  const ids = sql.join(debts.map((d) => sql`${d.id}::uuid`), sql`, `);
  const links = await rows<{ debt_id: string; role: string; party_id: string; name: string }>(db, sql`
    SELECT dp.debt_id, dp.role::text AS role, dp.party_id, p.name FROM debt_parties dp
    JOIN parties p ON p.id = dp.party_id WHERE dp.debt_id IN (${ids}) ORDER BY dp.created_at`);
  const decisions = await rows<{ debt_id: string; status: string }>(db, sql`
    SELECT DISTINCT ON (debt_id) debt_id, status FROM registry_decisions WHERE debt_id IN (${ids})
    ORDER BY debt_id, created_at DESC`);
  return debts.map((d) => ({
    type: "debt", id: d.id, name: d.creditor_name,
    claimed: euro(d.claimed_cents), principal: d.principal_cents == null ? null : euro(d.principal_cents),
    references: d.references, reportedToVerder: iso(d.reported_to_verder_at),
    decision: decisions.find((x) => x.debt_id === d.id)?.status ?? null,
    parties: links.filter((l) => l.debt_id === d.id).map((l) => ({ role: l.role, type: "party", id: l.party_id, name: l.name })),
  }));
}

async function tasksWhere(db: Db, where: SQL, statuses: readonly string[] | null, max: number): Promise<Record<string, unknown>[]> {
  const ts = await rows<{ id: string; title: string; details: string | null; due_at: string | null; assignee_party_id: string | null;
    debt_id: string | null; document_id: string | null }>(db, sql`
    SELECT id, title, details, due_at, assignee_party_id, debt_id, document_id FROM tasks WHERE ${where}
    ORDER BY due_at NULLS LAST, created_at, id LIMIT 300`);
  const st = await effectiveTaskStatuses(db, ts.map((t) => t.id));
  return ts.filter((t) => !statuses || statuses.includes(st.get(t.id) ?? "open")).slice(0, max).map((t) => ({
    type: "task", id: t.id, title: t.title, status: st.get(t.id) ?? "open", due: iso(t.due_at),
    details: clip(t.details, 300), partyId: t.assignee_party_id, debtId: t.debt_id, documentId: t.document_id,
  }));
}
const LIVE_TASK = ["open", "in-progress", "waiting"] as const;

const getParty: ToolDef = {
  name: "get_party",
  description: "One party (organisation or person): email, kind, its parent organisation and contact persons, the debts it claims or acts in, and its open tasks.",
  args: z.object({ id: uuid }).strict(),
  async run(env, a) {
    const [p] = await rows<PartyRow>(env.db, sql`SELECT id, kind::text AS kind, name, organization, email, parent_party_id
      FROM parties WHERE id = ${a.id}`);
    if (!p) return { data: { error: "Deze partij bestaat niet." } };
    const related = await rows<PartyRow>(env.db, sql`SELECT id, kind::text AS kind, name, organization, email, parent_party_id
      FROM parties WHERE id = ${p.parent_party_id ?? "00000000-0000-0000-0000-000000000000"}::uuid OR parent_party_id = ${p.id}::uuid
      ORDER BY name`);
    return { data: {
      party: partyItem(p),
      parent: related.filter((r) => r.id === p.parent_party_id).map(partyItem)[0] ?? null,
      contacts: related.filter((r) => r.parent_party_id === p.id).map(partyItem),
      debts: await debtsWhere(env.db, sql`d.creditor_party_id = ${p.id}::uuid
        OR EXISTS (SELECT 1 FROM debt_parties x WHERE x.debt_id = d.id AND x.party_id = ${p.id}::uuid)`),
      openTasks: await tasksWhere(env.db, sql`assignee_party_id = ${p.id}::uuid`, LIVE_TASK, 20),
    } };
  },
};

const listParties: ToolDef = {
  name: "list_parties",
  description: "Parties in the dossier (organisations and people) by words in the name, organisation or email.",
  args: z.object({ query: words.optional(), limit: limit(60, 30) }).strict(),
  async run(env, a) {
    const where = a.query ? sql`name ILIKE ${like(a.query)} OR organization ILIKE ${like(a.query)} OR email ILIKE ${like(a.query)}` : sql`TRUE`;
    const ps = await rows<PartyRow>(env.db, sql`SELECT id, kind::text AS kind, name, organization, email, parent_party_id
      FROM parties WHERE ${where} ORDER BY name, id LIMIT ${a.limit}`);
    return { data: { items: ps.map(partyItem) } };
  },
};

const listDebts: ToolDef = {
  name: "list_debts",
  description: "The debt registry: each claim with its creditor, the amount claimed (an unknown amount stays 'onbekend' — never assume 0), the parties per role (eiser, incasso, deurwaarder, gemachtigde), whether Verder was told, and Martin's latest decision.",
  args: z.object({ partyId: uuid.optional() }).strict(),
  async run(env, a) {
    const where = a.partyId
      ? sql`d.creditor_party_id = ${a.partyId}::uuid OR EXISTS (SELECT 1 FROM debt_parties x WHERE x.debt_id = d.id AND x.party_id = ${a.partyId}::uuid)`
      : sql`TRUE`;
    return { data: { items: await debtsWhere(env.db, where) } };
  },
};

const caseMap: ToolDef = {
  name: "case_map",
  description: "The case as a map: tracks (sporen, with status) and their stops (haltes: title, state, date, note), and the current open stop — where things stand. Pass trackId to see one spoor's stops only.",
  args: z.object({ trackId: uuid.optional() }).strict(),
  async run(env, a) {
    const input = await loadTrackMapRows(env.db);
    const map = buildTrackMap(input);
    const stops = a.trackId ? input.stops.filter((s) => s.trackId === a.trackId) : input.stops;
    return { data: {
      currentStopId: map.currentStopId,
      tracks: input.tracks.map((t) => ({ type: "track", id: t.id, title: t.title, status: t.status,
        parentTrackId: t.parentTrackId, note: clip(t.note, 200) })),
      stops: stops.map((s) => ({ type: "stop", id: s.id, trackId: s.trackId, title: s.title, state: s.state,
        date: iso(s.happenedAt), note: clip(s.note, 200), taskId: s.taskId, documentId: s.documentId })),
    } };
  },
};

const listTasks: ToolDef = {
  name: "list_tasks",
  description: "Tasks with their effective status (open, in-progress, waiting, done, dropped). By default only the live ones (open, in-progress, waiting).",
  args: z.object({
    status: z.array(z.enum(["open", "in-progress", "waiting", "done", "dropped"])).max(5).optional(),
    partyId: uuid.optional(),
    title: words.optional(),
    limit: limit(60, 30),
  }).strict(),
  async run(env, a) {
    const where: SQL[] = [];
    if (a.partyId) where.push(sql`assignee_party_id = ${a.partyId}::uuid`);
    if (a.title) where.push(sql`title ILIKE ${like(a.title)}`);
    return { data: { items: await tasksWhere(env.db, and(where), a.status ?? LIVE_TASK, a.limit) } };
  },
};

const listEntries: ToolDef = {
  name: "list_entries",
  description: "Logbook entries (calls, meetings, mails, letters Martin recorded), newest first, by party, period or words in the summary or details. A corrected entry shows only its newest version.",
  args: z.object({
    partyId: uuid.optional(),
    from: day.optional(), to: day.optional(),
    query: words.optional(),
    limit: limit(40, 20),
  }).strict(),
  async run(env, a) {
    const where: SQL[] = [sql`NOT EXISTS (SELECT 1 FROM log_entries n WHERE n.supersedes_id = e.id)`];
    if (a.partyId) where.push(sql`EXISTS (SELECT 1 FROM entry_participants ep WHERE ep.entry_id = e.id AND ep.party_id = ${a.partyId}::uuid)`);
    if (a.from) where.push(sql`${amsterdamDay(sql`e.occurred_at`)} >= ${a.from}::date`);
    if (a.to) where.push(sql`${amsterdamDay(sql`e.occurred_at`)} <= ${a.to}::date`);
    if (a.query) where.push(sql`(e.summary ILIKE ${like(a.query)} OR e.details ILIKE ${like(a.query)})`);
    const es = await rows<{ id: string; occurred_at: string; channel: string; direction: string; summary: string; details: string | null }>(
      env.db, sql`SELECT e.id, e.occurred_at, e.channel::text AS channel, e.direction::text AS direction, e.summary, e.details
        FROM log_entries e WHERE ${and(where)} ORDER BY e.occurred_at DESC, e.id LIMIT ${a.limit}`);
    return { data: { items: es.map((e) => ({ type: "entry", id: e.id, date: iso(e.occurred_at), channel: e.channel,
      direction: e.direction, summary: e.summary, details: e.details ? page(e.details, 0).text.slice(0, 600) : null })) } };
  },
};

export const TOOLS: readonly ToolDef[] = [
  search, getDocument, listDocuments, getMail, listMail, gmailSearch, gmailRead,
  listTransactions, getParty, listParties, listDebts, caseMap, listTasks, listEntries,
];

export const toolByName = (name: string): ToolDef | undefined => TOOLS.find((t) => t.name === name);
