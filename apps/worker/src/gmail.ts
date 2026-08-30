import { asc, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { ingestDocument } from "@verder/api/src/routers/documents";
import { storeFile } from "@verder/api/src/storage";
import { recordRun } from "./heartbeat";
import { asciiLower, isRelevantMessage, relevantAddresses } from "./mail/relevance";
import { extractMessageId } from "./mail/message-id";
import type { MailMessage, SkippedPart } from "./mail/port";

/** A message part the port refused to promote to a document — see
 *  isInlineBodyImage. Reported so a wrong skip is visible the same day rather
 *  than never: the part is gone from every surface and re-polling will not
 *  fetch it again.
 *
 *  ONE definition, two consumers: it lives in ./mail/port and is re-exported
 *  here so the Gmail and JMAP ports cannot drift apart. */
export type { SkippedPart };

export interface GmailMessage {
  id: string; threadId: string; from: string; to: string; subject: string;
  sentAt: Date; bodyText: string; raw: Buffer;
  attachments: { filename: string; mime: string; data: Buffer }[];
  skippedParts?: SkippedPart[];
}
export interface GmailPort {
  listMessageIds(query: string): Promise<string[]>;
  getMessage(id: string): Promise<GmailMessage>;
}

/**
 * A GmailMessage as the MailMessage the ingest takes.
 *
 * The two shapes now differ in exactly one field, and it is the one that spans
 * the two ingest namespaces: the RFC 5322 Message-ID. The JMAP port asks the
 * server for it as a header PROPERTY, which costs no blob and is what lets
 * pollMail skip a message the dossier already holds before downloading it. The
 * Gmail API offers no such form, so this path reads it out of the RFC822
 * original — which it is holding anyway, since ingestRawEmail is about to write
 * those very bytes to the vault. Still one source per port, never two per
 * message: nothing here re-derives what a port already reported.
 *
 * Filled at the ingest boundary rather than by widening GmailMessage, because
 * that would make the field required of every Gmail-era fixture and of
 * gmail-auth's part walker — real work spent on a path that is unscheduled and
 * being replaced by JMAP.
 */
export function asMailMessage(msg: GmailMessage): MailMessage {
  return { ...msg, messageId: extractMessageId(msg.raw) };
}

/**
 * A whole address, ASCII only, already folded — the same shape as
 * `mail/relevance.ts`'s private `ADDRESS_RE`. Duplicated deliberately rather
 * than exported from there: `relevance.ts` is explicitly off limits for this
 * fix (its two callers, `addressesInHeader` and `isRelevantMessage`, want
 * every address a header names and must not change), and this module's
 * notion of "one address" is a different, stricter question — see
 * `senderAddress` below.
 */
const SENDER_ADDRESS_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/**
 * The ONE address a `From` header names — or `null`.
 *
 * WHAT IT ACCEPTS, and nothing else:
 *   - `[display-name] <addr-spec>` — exactly ONE top-level `<...>` pair with
 *     nothing but whitespace after the `>`; the address is that pair's
 *     content. A `<`, `>`, `,` or `:` inside a QUOTED display name is part of
 *     the name and not punctuation, so `"Doe, John" <j@d.nl>` and
 *     `"<demi@verdergroep.nl>" <a@evil.tld>` both resolve to the real mailbox.
 *   - a bare `addr-spec` — no angle brackets at all, and the whole trimmed
 *     header is an address.
 * In both cases the candidate must satisfy `SENDER_ADDRESS_RE` in its
 * ENTIRETY. Nothing is ever extracted from inside a longer string.
 *
 * EVERYTHING ELSE IS REFUSED, in particular:
 *   - any `(` or `)` ANYWHERE, quoted or not. RFC 5322 comments nest AND take
 *     `quoted-pair` escapes, and three review rounds showed that a stripper
 *     for them is a decoy generator, not a defence: `<a@evil.tld> ( \) <d@watched.nl> \( )`
 *     is a fully VALID header whose comment a hand-written stripper
 *     mis-terminates, leaking the watched address to the top level. Comments
 *     in a real-world `From` are vanishingly rare; a parser bug here is
 *     permanent evidence. So there is no comment support at all.
 *   - more than one top-level `<` (`<a@evil.tld> <d@watched.nl>`, `<<d@watched.nl>>`),
 *     a `>` with no `<`, a second `>`, or an unterminated `<` or `"`. One
 *     mailbox or nothing — never a positional pick among several.
 *   - a top-level `,`, `:` or `;` — a mailbox list, or the group syntax
 *     (`undisclosed-recipients:;`, `Groep: <d@watched.nl>;`). All three are
 *     `specials` that an unquoted display-name phrase may not contain, so
 *     refusing them costs no correctly formed sender.
 *
 * WHY REFUSING IS THE CHEAP FAILURE — the reason for every rule above. This
 * header is text the SENDER writes, and a message reaches ingest when ANY
 * address in it matches a watched party, so a header carrying a decoy address
 * is reachable end to end. A resolved sender is written into an append-only
 * `documents` row and into a `document.ingested` ledger payload, and neither
 * has an UPDATE grant: a wrong attribution can NEVER be corrected. A refusal
 * costs an "Onbekend" a human fixes in the UI in seconds. When in doubt,
 * resolve nothing.
 *
 * NO SUBSTRING INVARIANT IS CLAIMED, because the earlier one was false: this
 * docblock used to say comment-stripping "can only ever remove a candidate
 * address, never manufacture one", and `att(x)acker@evil.tld` stripped to
 * `attacker@evil.tld` — an address appearing nowhere in the input. The rule
 * now is checkable instead: what is returned is one contiguous slice of the
 * header (or the whole header), ASCII-folded and matched WHOLE against one
 * regex.
 */
export function senderAddress(header: string): string | null {
  // Parentheses anywhere at all. This IS the deletion of stripComments, not a
  // fast path around it — see the docblock.
  if (header.includes("(") || header.includes(")")) return null;

  let inQuotes = false;
  let open = -1; // index of the one top-level "<"
  let close = -1; // index of the one top-level ">"

  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (inQuotes) {
      // RFC 5322 quoted-pair: a backslash escapes the next character, so it
      // cannot end the quoted string even when that next character is a `"`.
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inQuotes = false;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === "<") {
      if (open !== -1) return null; // a second mailbox, or a nested "<"
      open = i;
      continue;
    }
    if (ch === ">") {
      if (open === -1 || close !== -1) return null; // stray, or a second ">"
      close = i;
      continue;
    }
    // A mailbox list, or a group. Either way the header names something other
    // than exactly one mailbox.
    if (ch === "," || ch === ":" || ch === ";") return null;
  }
  if (inQuotes) return null; // unterminated quoted string
  if (open !== -1 && close === -1) return null; // unterminated "<"

  let candidate: string;
  if (open === -1) {
    candidate = header.trim();
  } else {
    // `angle-addr` allows only CFWS after the ">", and comments are already
    // refused above — so anything but whitespace here is unaccounted-for text.
    if (header.slice(close + 1).trim() !== "") return null;
    candidate = header.slice(open + 1, close).trim();
  }
  if (!candidate) return null;
  const folded = asciiLower(candidate);
  return SENDER_ADDRESS_RE.test(folded) ? folded : null;
}

/**
 * The sender of a message, resolved to a party — or undefined, the honest
 * outcome when no party matches (an upload and a scan legitimately have no
 * sender either, which is why `ingestDocument`'s `partyId` stays optional).
 *
 * `fromHeader` is PARSED by `senderAddress`, not compared as a whole string
 * and not treated as a flat bag of addresses: under Gmail it is a raw header
 * (`Demi Willemse <demi@verdergroep.nl>`, or worse — see `senderAddress`'s
 * own docs for the attacks a naive extraction fell for), and comparing that
 * whole string against `parties.email` (a bare address) would never match
 * real mail.
 *
 * Folded with `asciiLower`, on BOTH sides, in JS — never SQL `lower()`, which
 * is Unicode-aware: U+212A KELVIN SIGN folds to ASCII "k" under `lower()`,
 * which would let a sender-chosen header fold into an address the dossier
 * watches (`mail/relevance.ts`'s own finding, word for word). `senderAddress`
 * already folds its return value, so only the party side needs it here.
 *
 * `ORDER BY created_at, id` is a deterministic tiebreak for the case two
 * parties share an email — there is no ranking rule for that, so "oldest
 * wins" is at least the same choice `case-history`'s document lookup makes,
 * not an arbitrary one.
 */
async function resolveSenderPartyId(tx: Db, fromHeader: string): Promise<string | undefined> {
  const fromAddr = senderAddress(fromHeader);
  if (!fromAddr) return undefined;
  const parties = await tx.select({ id: schema.parties.id, email: schema.parties.email })
    .from(schema.parties)
    .orderBy(asc(schema.parties.createdAt), asc(schema.parties.id));
  return parties.find((p) => p.email && asciiLower(p.email) === fromAddr)?.id;
}

/**
 * Evidence-first ingest of one Gmail message: persist the canonical RFC822
 * original (full headers: Received, Message-ID, DKIM...) to the vault before
 * AI runs. A bare hash is only verifiable while Gmail retains the message; the
 * vault copy makes it independently verifiable forever. Attachments become
 * vault-backed documents in the same transaction.
 *
 * `skipSuggest` is for receipt lookups (registry aggregator resolution): those
 * emails are financial evidence, not correspondence, so no suggest.entry job
 * is ever owed — stamping the outbox marker at insert time keeps pollGmail's
 * outbox repair from enqueuing one later.
 *
 * `msg` is a MailMessage, not a GmailMessage: the transaction is the same
 * whichever port produced the message, and `source` LABELS the row with the
 * channel it arrived over. It never rewrites gmail_message_id, which is also
 * documents.source_ref and what the case map's third level derives from.
 */
export async function ingestRawEmail(
  deps: { db: Db; vaultDir: string },
  msg: MailMessage,
  opts?: { skipSuggest?: boolean; source?: "gmail" | "jmap" },
): Promise<string> {
  return deps.db.transaction(async (tx) => {
    const { sha256: rawSha256 } = await storeFile(deps.vaultDir, msg.raw);
    const [row] = await tx.insert(schema.rawEmails).values({
      gmailMessageId: msg.id, gmailThreadId: msg.threadId,
      fromAddr: msg.from, toAddr: msg.to, subject: msg.subject,
      sentAt: msg.sentAt, rawRfc822Sha256: rawSha256,
      bodyText: msg.bodyText,
      // THE IDENTITY THAT SPANS THE TWO INGEST NAMESPACES, written at the one
      // moment it is free to write. A row ingested without it is a row the next
      // re-import cannot recognise — neither its gmail_message_id (a Stalwart
      // Email id is a different namespace) nor its content hash (Takeout's mbox
      // bytes are not the bytes Gmail's API returned) matches — so it is a
      // permanent duplicate in an append-only table plus one redundant LLM job,
      // and the only repair afterwards is a hand-run backfill.
      //
      // THE FALLBACK IS NOT BELT-AND-BRACES. The JMAP port asks the server for
      // the header as a PROPERTY, which is what lets pollMail skip a known
      // message before downloading it, but a MailMessage may still arrive with
      // none: an mbox-imported message whose header property the store did not
      // index, or any future port that fills the field lazily. The raw bytes
      // are the backstop and they are already in hand here — storeFile has just
      // hashed and written this very buffer — so reading the header out of them
      // costs one pass over a few kilobytes and no I/O at all. `??` and not
      // `||`: null is "the port did not say", and there is no other falsy value
      // extractMessageId can produce that would mean anything else.
      messageId: msg.messageId ?? extractMessageId(msg.raw),
      source: opts?.source ?? "gmail",
      ...(opts?.skipSuggest ? { suggestQueuedAt: new Date() } : {}),
    }).returning();
    // One lookup per MESSAGE, not per attachment: every attachment on this
    // message shares one sender. See resolveSenderPartyId for why this is not
    // a plain string/SQL-lower() comparison against msg.from.
    const senderPartyId = await resolveSenderPartyId(tx, msg.from);
    for (const att of msg.attachments) {
      const { sha256 } = await storeFile(deps.vaultDir, att.data);
      await ingestDocument(tx, { sha256, sizeBytes: att.data.length,
        mime: att.mime, title: att.filename, source: "email-attachment",
        sourceRef: msg.id, receivedAt: msg.sentAt, partyId: senderPartyId });
    }
    return row.id;
  });
}

/**
 * The instant a Gmail 429 tells us to come back, pulled out of the error text.
 *
 * Google puts it in the message rather than in a Retry-After header:
 * `User-rate limit exceeded.  Retry after 2026-08-22T21:26:14.735Z`. Returns
 * null for any other failure, which is what keeps an ordinary network blip from
 * silently muting the poller.
 */
export function retryAfterFrom(err: unknown): Date | null {
  const m = /Retry after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(String(err));
  if (!m) return null;
  const when = new Date(m[1]);
  return Number.isNaN(when.getTime()) ? null : when;
}

/**
 * The retry instant the last `gmail` run recorded, if it is still in the future.
 *
 * WHY THIS EXISTS. A Gmail user-rate limit is account-wide and every attempt
 * against it RESETS the deadline to a fresh fifteen minutes. With `gmail.poll`
 * scheduled every three minutes the cron alone re-arms the lockout five times
 * per window, so one 429 becomes a permanent one and mail ingestion stays down
 * until somebody notices a `worker_runs` row. Measured on 2026-08-22: a stair of
 * errors marching 20:42→20:57, 20:45→21:00, 20:48→21:03, 20:51→21:06, and the
 * only cure was stopping the container by hand.
 *
 * So the deadline has to survive between polls, and `worker_runs` is where it
 * lives — no new table for one timestamp. The skip records itself CARRYING THE
 * SAME instant forward, because this reads the latest run: a skip that dropped
 * it would clear the memory and the next tick would poll straight into the
 * limit again.
 */
async function rateLimitedUntil(db: Db): Promise<Date | null> {
  const [last] = await db.select({ detail: schema.workerRuns.detail })
    .from(schema.workerRuns).where(eq(schema.workerRuns.worker, "gmail"))
    .orderBy(desc(schema.workerRuns.ranAt)).limit(1);
  const raw = (last?.detail as { retryAfter?: unknown } | null)?.retryAfter;
  if (typeof raw !== "string") return null;
  const when = new Date(raw);
  return !Number.isNaN(when.getTime()) && when > new Date() ? when : null;
}

/**
 * Gmail `q` strings that ask the SERVER to do the filtering.
 *
 * WHY THIS EXISTS. pollGmail used to list `newer_than:7d` — every message in the
 * mailbox — fetch each one in full, and only then ask whether the sender
 * mattered. On a mailbox with thousands of commercial mails that is hundreds of
 * `messages.get` calls per tick at 20 quota units each, against a budget of
 * 6.000 per minute, every three minutes, for a hit rate near zero. Measured
 * 2026-08-29: 378 rate-limited skips in 24 hours and an ~18-minute lockout loop
 * the poller could not escape. Filtering server-side costs 5 units per page.
 *
 * BOTH DIRECTIONS, always. `to:` is what finds the mail Martin SENT to a party;
 * scoping on `from:` alone is why none of his outbound post — the whole
 * moratorium package, paspoort, loonstroken — was ever ingested.
 *
 * A leading "@" is stripped for the query (`from:(verdergroep.nl)` matches any
 * address at the domain) while the raw form is kept for the in-process check.
 */
const QUERY_MAX = 1500;

export function buildQueries(window: string, addrs: string[]): string[] {
  // THE TRAP: no addresses must mean NO query. Returning the bare window would
  // match the entire mailbox, which is precisely the burn being removed.
  if (addrs.length === 0) return [];
  const render = (chunk: string[]) => {
    const list = chunk.map((a) => a.replace(/^@/, "")).join(" OR ");
    return `${window} AND (from:(${list}) OR to:(${list}))`;
  };
  const queries: string[] = [];
  let chunk: string[] = [];
  for (const a of addrs) {
    if (chunk.length && render([...chunk, a]).length > QUERY_MAX) {
      queries.push(render(chunk));
      chunk = [a];
    } else {
      chunk.push(a);
    }
  }
  if (chunk.length) queries.push(render(chunk));
  return queries;
}

export async function pollGmail(deps: {
  db: Db; gmail: GmailPort; vaultDir: string;
  enqueueSuggest: (rawEmailId: string) => Promise<void>;
  window?: string;
}): Promise<{ ingested: number }> {
  let ingested = 0;
  const failures: { id: string; message: string }[] = [];
  // Parts the port refused to promote. `scanned` counts messages, not parts, so
  // without this a heuristic that reads a sender's mailer wrongly would drop
  // documents with nothing anomalous anywhere to look at.
  const skippedParts: (SkippedPart & { messageId: string })[] = [];

  // Honour a live rate-limit deadline before touching the API at all. Recorded
  // as `ok`, not `error`: waiting out a limit correctly is the poller working,
  // and a stream of red rows would bury the failure that actually needs a human.
  const until = await rateLimitedUntil(deps.db);
  if (until) {
    await recordRun(deps.db, "gmail", "ok",
      { skipped: "rate-limited", retryAfter: until.toISOString() });
    return { ingested: 0 };
  }

  try {
    const addrs = await relevantAddresses(deps.db);
    const queries = buildQueries(deps.window ?? "newer_than:7d", addrs);
    // Chunks overlap in nothing but their results: the same thread can surface
    // in two queries, and a second getMessage would cost 20 units for bytes
    // already in hand.
    const seenIds = new Set<string>();
    const ids: string[] = [];
    for (const q of queries) {
      for (const id of await deps.gmail.listMessageIds(q)) {
        if (!seenIds.has(id)) { seenIds.add(id); ids.push(id); }
      }
    }
    for (const id of ids) {
      // One bad message must not block the rest of the mailbox: isolate each
      // message so a persistent failure only surfaces in worker_runs while
      // every other message still ingests.
      try {
        const [seen] = await deps.db.select().from(schema.rawEmails)
          .where(eq(schema.rawEmails.gmailMessageId, id));
        if (seen) {
          // Outbox repair: the ingest committed but the suggest.entry enqueue
          // failed afterwards (send error or crash). Retry it now, otherwise
          // the email never reaches the review queue.
          if (!seen.suggestQueuedAt) await enqueueAndMark(deps, seen.id);
          continue;
        }
        const msg = await deps.gmail.getMessage(id);
        for (const p of msg.skippedParts ?? []) skippedParts.push({ ...p, messageId: id });
        // Belt and braces behind the server-side filter, and it must test the
        // SAME two headers the query does — checking `from` alone would fetch
        // Martin's own sent mail and then throw it away. The predicate lives in
        // ./mail/relevance so pollMail applies this identical policy.
        if (!isRelevantMessage(addrs, msg)) continue;
        const rawEmailId = await ingestRawEmail(deps, asMailMessage(msg));
        await enqueueAndMark(deps, rawEmailId);
        ingested++;
      } catch (err) {
        failures.push({ id, message: String(err) });
      }
    }
    await recordRun(deps.db, "gmail", failures.length ? "error" : "ok",
      { ingested, scanned: ids.length, failures, skippedParts });
  } catch (err) {
    // A rate limit is remembered so the next tick skips instead of re-arming
    // it. Everything else stays a plain error with no deadline attached, which
    // is what stops a transient network failure from muting the poller.
    const retryAfter = retryAfterFrom(err);
    await recordRun(deps.db, "gmail", "error", {
      message: String(err),
      ...(retryAfter ? { retryAfter: retryAfter.toISOString() } : {}),
    });
    throw err;
  }
  return { ingested };
}

// Enqueue the suggest job, then mark the raw email as enqueued. If the mark
// itself fails the job is merely sent again next poll (at-least-once), which
// beats the alternative of an email that never reaches the review queue.
async function enqueueAndMark(
  deps: { db: Db; enqueueSuggest: (rawEmailId: string) => Promise<void> },
  rawEmailId: string,
): Promise<void> {
  await deps.enqueueSuggest(rawEmailId);
  await deps.db.update(schema.rawEmails).set({ suggestQueuedAt: new Date() })
    .where(eq(schema.rawEmails.id, rawEmailId));
}
