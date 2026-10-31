import { isNotNull, eq } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { senderAddress } from "../gmail";
import {
  asciiLower, operatorAddresses, ownMailboxAddresses, sanitizeAddresses,
} from "./relevance";

/**
 * WHOSE MAIL IS WORTH INTERRUPTING MARTIN FOR (spec §6.4, §12.5).
 *
 * `verder` is time-sensitive, `creditor` is active, everything else that is
 * relevant is ingested quietly. The Verder set is `operatorAddresses()` — THE
 * SAME list relevance reads, so priority can never name an organisation the
 * ingest does not, and never adds an address to it. Creditors are parties
 * already linked to a debt; nothing here creates a party, because every
 * `parties.email` widens ingest.
 *
 * SPOOFING, and why the trade is accepted. Priority is decided on the `From`
 * header ONLY, parsed with the strict `senderAddress` — never
 * `addressesInHeader`, which returns every address-shaped substring of the
 * header including the display name, so `"demi@verdergroep.nl" <attacker@evil.tld>`
 * would rank `verder`. With `senderAddress` the display name is never read, so
 * a display-name spoof costs NOTHING. A forged From whose ACTUAL mailbox
 * claims Verder costs one false time-sensitive push: spec §12.5 accepts that,
 * because a missed Verder letter costs more than a false alarm. It never costs
 * a send, because sending needs Martin's approval of the final text.
 */

export type MailPriority = "verder" | "creditor" | "other";

export interface PrioritySets {
  /** `operatorAddresses().addrs` — `@domain` entries and whole addresses. */
  verder: string[];
  /** Emails of parties linked to a debt, sanitised as `"party"` (no domains). */
  creditorAddresses: string[];
  /** Martin's own mailbox(es), from `ownMailboxAddresses()`. */
  own: string[];
}

/** A creditor as `letterSender` wants it. `email` is optional so a caller with
 *  only names (a party without one) needs no placeholder. */
export interface CreditorParty { partyId: string; name: string; email?: string | null }

/** Every party linked to a debt, by `debts.creditor_party_id` OR by a
 *  `debt_parties` edge (eiser, incasso, deurwaarder, gemachtigde — whoever
 *  writes on the claim's behalf). Deduplicated by party id. */
export async function creditorParties(db: Db): Promise<CreditorParty[]> {
  const viaDebt = await db
    .select({ partyId: schema.parties.id, name: schema.parties.name, email: schema.parties.email })
    .from(schema.debts)
    .innerJoin(schema.parties, eq(schema.parties.id, schema.debts.creditorPartyId))
    .where(isNotNull(schema.debts.creditorPartyId));
  const viaEdge = await db
    .select({ partyId: schema.parties.id, name: schema.parties.name, email: schema.parties.email })
    .from(schema.debtParties)
    .innerJoin(schema.parties, eq(schema.parties.id, schema.debtParties.partyId));
  const byId = new Map<string, CreditorParty>();
  for (const p of [...viaDebt, ...viaEdge]) if (!byId.has(p.partyId)) byId.set(p.partyId, p);
  return [...byId.values()];
}

export async function prioritySets(db: Db): Promise<PrioritySets> {
  const own = ownMailboxAddresses();
  const creditors = await creditorParties(db);
  return {
    verder: operatorAddresses().addrs,
    creditorAddresses: sanitizeAddresses(creditors.map((c) => c.email ?? ""), own, "party").addrs,
    own,
  };
}

/** The same whole-domain-or-whole-address rule as `isRelevantMessage`: a
 *  `@domain` entry is that domain EXACTLY (no subdomains), an address entry is
 *  the whole address. `addr` is already folded by `senderAddress`. */
function matchesList(list: string[], addr: string): boolean {
  const domain = addr.slice(addr.lastIndexOf("@"));
  for (const raw of list) {
    const a = asciiLower(raw.trim());
    if (!a) continue;
    if (a.startsWith("@") ? domain === a : addr === a) return true;
  }
  return false;
}

/** Martin's own mail — outbound, never priority, even when it is TO Verder. */
export function isOwnOutbound(sets: PrioritySets, msg: { from: string }): boolean {
  const addr = senderAddress(msg.from);
  return addr !== null && sets.own.some((o) => asciiLower(o.trim()) === addr);
}

/**
 * Decided on `from` ONLY. A `null` from `senderAddress` (a refused header: a
 * comment, a list, a group, two mailboxes) is `other`, never priority.
 * `senderAddress` accepts a bare address, so JMAP rows (bare `from_addr`) and
 * Gmail-era rows (the whole header) go through the same call.
 */
export function mailPriority(sets: PrioritySets, msg: { from: string }): MailPriority {
  const addr = senderAddress(msg.from);
  if (addr === null) return "other";
  if (sets.own.some((o) => asciiLower(o.trim()) === addr)) return "other";
  if (matchesList(sets.verder, addr)) return "verder";
  if (matchesList(sets.creditorAddresses, addr)) return "creditor";
  return "other";
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `needle` (already folded) as a whole token of `hay`: not glued to a longer
 *  host or local part on either side. A trailing `.` is allowed only when no
 *  label follows it (end of a sentence), so `verdergroep.nl.evil.tld` is not
 *  `verdergroep.nl`. A leading `.` or `@` IS allowed for a domain — that is
 *  `www.verdergroep.nl` and `opstart@verdergroep.nl` — but not for an address. */
function hasDomainToken(hay: string, domain: string): boolean {
  return new RegExp(`(?<![a-z0-9-])${escapeRe(domain)}(?![a-z0-9-]|\\.[a-z0-9])`).test(hay);
}
function hasAddressToken(hay: string, addr: string): boolean {
  return new RegExp(
    `(?<![a-z0-9!#$%&'*+/=?^_\`{|}~.-])${escapeRe(addr)}(?![a-z0-9-]|\\.[a-z0-9])`,
  ).test(hay);
}

/** Collapse OCR line breaks and runs of spaces, so a name broken over two
 *  lines of a letterhead still reads as the name. */
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Shorter names ("Bol", "CAK") are words a letter uses for other reasons. */
const MIN_CREDITOR_NAME = 6;

/**
 * WHO A SCANNED LETTER IS FROM — a GUESS, because the text came from OCR
 * (spec §12.5: the push says "lijkt van Verder" and the sender stays
 * unconfirmed until Martin or the filing confirms it).
 *
 *   - `verder` when the text carries a Verder domain from the list as a whole
 *     token — `@verdergroep.nl` in an address, `verdergroep.nl` in a URL or a
 *     letterhead — or a whole Verder address from the list. The bare word
 *     "verder" ("wij gaan verder") is ordinary Dutch and never counts.
 *   - otherwise `creditor` when it carries a creditor party's email, or its
 *     exact name (case-insensitive, at least MIN_CREDITOR_NAME characters, as
 *     a whole phrase).
 *   - otherwise `null`.
 *
 * Domains and addresses are folded with `asciiLower`, like every address in
 * this module. A NAME is matched with `toLowerCase`: names are not addresses
 * (`Het CAK`, `Woonhave`, Unicode is legitimate there), and a wrong creditor
 * hit costs only an `active` push.
 */
export function letterSender(
  sets: PrioritySets, text: string, creditorNames: CreditorParty[],
): { kind: "verder" } | { kind: "creditor"; partyId: string } | null {
  const folded = asciiLower(text);
  for (const raw of sets.verder) {
    const a = asciiLower(raw.trim());
    if (!a) continue;
    const hit = a.startsWith("@") ? hasDomainToken(folded, a.slice(1)) : hasAddressToken(folded, a);
    if (hit) return { kind: "verder" };
  }

  for (const c of creditorNames) {
    const [email] = sanitizeAddresses([c.email ?? ""], sets.own, "party").addrs;
    if (email && hasAddressToken(folded, email)) return { kind: "creditor", partyId: c.partyId };
  }
  const prose = squash(text).toLowerCase();
  for (const c of creditorNames) {
    const name = squash(c.name).toLowerCase();
    if (name.length < MIN_CREDITOR_NAME) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, "u");
    if (re.test(prose)) return { kind: "creditor", partyId: c.partyId };
  }
  return null;
}
