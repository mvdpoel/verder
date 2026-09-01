// The two questions "how much mail is in this store" and "how is it split
// across mailboxes", asked over JMAP, in ONE definition.
//
// WHY THIS MODULE EXISTS, and it is a defect this file was extracted to close.
// Both questions are asked TWICE, by two halves of the same feature: once by
// ops/mail-backup.sh when it writes the sidecar manifest beside a snapshot, and
// once by ops/mail-restore-drill.ts when it judges a restore against that
// manifest. The two readings must be the same reading — a manifest and a drill
// that count differently disagree about a store that is byte-perfect, and the
// drill then reports a healthy backup as broken every month until somebody
// stops reading it.
//
// It is not a hypothetical. The backup script's first version asked over its own
// hand-rolled JMAP client in a shell heredoc, and it had ALREADY drifted from
// this one in two ways before either had ever run: it kept the LAST of two
// mailboxes sharing a name where this sums them, and it dropped a mailbox whose
// `totalEmails` was absent where this refuses one. Either difference is a
// permanent red dot on a good backup.
//
// So the law from mail/from-env.ts applies one level down: there is ONE place
// this is spelled. A caller brings a session and a credential; this module
// brings the questions.
import { call } from "./jmap-client";
import type { JmapCredential, JmapSession } from "./jmap-client";

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
/** RFC 8620 §3.3: declare every capability relied on. The same pair jmap-port
 *  sends, for the same reason — mail alone is an under-declaration a strict
 *  server may refuse with unknownCapability. */
export const USING = [CORE, MAIL];

interface QueryResponse { ids?: string[]; total?: number }

/**
 * How many messages the store holds, UNFILTERED.
 *
 * `calculateTotal: true` with `limit: 1`: the answer is one number, and pulling
 * 146 270 ids through the wire to take their length would be a slower way to ask
 * the same question. The total is REQUIRED to be a number here rather than
 * falling back to `ids.length` — a server that ignores `calculateTotal` would
 * otherwise make this function answer 1, which passes nothing and explains
 * nothing.
 *
 * NO `filter` PROPERTY, EVER. MEASURED against production 2026-09-01: Email/query
 * FILTERS RETURN NOTHING on this store. A `subject` filter for a subject known
 * to be present answers 0, and so does `header: ["Message-ID"]`, which asks only
 * whether the header EXISTS and cannot honestly be zero across 146 270 messages.
 * That is a separate known defect — most likely a full-text index Vandelay's
 * import never populated — and a filtered count would report 0 for a perfectly
 * good store. The test asserts the request body carries no such key.
 */
export async function countMessages(
  s: JmapSession, auth: JmapCredential, fetchFn: typeof fetch = fetch,
): Promise<number> {
  const [q] = await call<QueryResponse>(s, auth, USING, [["Email/query", {
    accountId: s.accountId, calculateTotal: true, limit: 1,
  }, "c0"]], fetchFn);
  const total = q?.total;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw new Error("JMAP Email/query answered no usable total "
      + "(calculateTotal was requested); a count cannot be inferred from a page");
  }
  return total;
}

interface MailboxRow { name?: unknown; totalEmails?: unknown }

/**
 * Every mailbox and how many messages it holds.
 *
 * `ids` IS OMITTED, AND THAT IS THE MEASURED SPELLING, not the tidy one. RFC 8620
 * §5.1 makes `ids` an `Id[]|null` argument with null meaning "all of them", so
 * `ids: null` says the same thing more explicitly and an earlier version of this
 * function sent it. But the call that was actually run against production on
 * 2026-09-01 — `Mailbox/get {properties:["name","totalEmails"]}`, which answered
 * with all 21 mailboxes — omitted the key. Both forms are legal and a conforming
 * server treats them alike; only one of them has been asked of THIS server. This
 * function is on two paths whose failure is quiet and monthly (a manifest that
 * silently stops being written, a drill whose rule 3 refuses to compare), so it
 * sends what was measured and the other spelling stays a note. Measure it before
 * changing it.
 *
 * TWO MAILBOXES MAY SHARE A NAME — JMAP puts no uniqueness rule on it, and two
 * `Archive` folders under different parents are ordinary. Their totals are
 * SUMMED here rather than the last one winning: keeping the last silently drops
 * the other's messages out of the comparison, which reads as agreement between
 * two stores that hold different things. The consequence, stated because it is a
 * real limit: this comparison is by name and cannot see a mailbox that was
 * RENAMED to another existing name. Names are what a manifest can carry across a
 * restore, where ids need not survive.
 *
 * A row missing `totalEmails` THROWS rather than counting as zero — a zero would
 * be compared, and quietly, against a real number.
 */
export async function mailboxTotals(
  s: JmapSession, auth: JmapCredential, fetchFn: typeof fetch = fetch,
): Promise<Record<string, number>> {
  const [r] = await call<{ list?: MailboxRow[] }>(s, auth, USING, [["Mailbox/get", {
    accountId: s.accountId, properties: ["name", "totalEmails"],
  }, "m0"]], fetchFn);
  const totals: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const row of r?.list ?? []) {
    const name = typeof row.name === "string" ? row.name : null;
    if (name === null) throw new Error("JMAP Mailbox/get returned a mailbox with no name");
    if (typeof row.totalEmails !== "number" || !Number.isInteger(row.totalEmails)) {
      throw new Error(`JMAP Mailbox/get returned no usable totalEmails for mailbox `
        + `${JSON.stringify(name)}`);
    }
    totals[name] = (totals[name] ?? 0) + row.totalEmails;
  }
  // Back to an ordinary object so JSON.stringify (worker_runs.detail, and the
  // manifest line) behaves.
  return { ...totals };
}
