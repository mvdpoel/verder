import { and, desc, eq, isNotNull } from "drizzle-orm";
import { schema, type Db } from "@verder/db";
import { senderAddress } from "../gmail";
import type { NotifyFn, NotifyInput } from "../notify/notify";
import { mailPriority, prioritySets } from "./priority";
import { asciiLower } from "./relevance";

/**
 * VERDER MAIL IS ALWAYS TOLD (spec §6.4). Runs after `suggestEntry` in the
 * `suggest.entry` job, so the push can carry the one-line summary the entry
 * prompt just wrote.
 *
 *   - verder   → time-sensitive, kind `verder-mail`
 *   - creditor → active, kind `creditor-mail`
 *   - anything else, Martin's own outbound mail included → nothing
 *
 * `suggest.entry` is AT-LEAST-ONCE, so the push carries `dedupKey
 * mail:<rawEmailId>` and notify()'s UNIQUE dedup_key makes a re-run send
 * nothing. `notifications` has no UPDATE and this push goes out BEFORE any
 * proposal exists, so it links to the Voor jou tab, never to a proposal. Its
 * `collapseId` is `mail:<rawEmailId>` as well: the "Voorstel" push for a
 * proposal triggered by this mail reuses it and REPLACES this alert on the
 * lock screen rather than stacking a second time-sensitive one under it.
 *
 * The sender is parsed with the strict `senderAddress` for both ingest
 * shapes — a Gmail-era row holds the whole `From` header, a JMAP row the bare
 * address — and matched against parties in JS with `asciiLower`, never SQL
 * `lower()` (the Unicode fold `relevance.ts` forbids for addresses).
 */
export async function notifyForMail(
  deps: { db: Db; notify: NotifyFn }, rawEmailId: string,
): Promise<void> {
  const { db } = deps;
  const [email] = await db.select().from(schema.rawEmails)
    .where(eq(schema.rawEmails.id, rawEmailId));
  if (!email) return;

  const sets = await prioritySets(db);
  const priority = mailPriority(sets, { from: email.fromAddr });
  if (priority === "other") return;

  const [suggestion] = await db.select({
    status: schema.suggestions.status, proposed: schema.suggestions.proposed,
  }).from(schema.suggestions)
    .where(and(eq(schema.suggestions.rawEmailId, rawEmailId),
      eq(schema.suggestions.kind, "log-entry")))
    .orderBy(desc(schema.suggestions.createdAt))
    .limit(1);
  const summary = suggestion && suggestion.status !== "needs-manual"
    ? (suggestion.proposed as { summary?: unknown } | null)?.summary
    : undefined;
  const body = typeof summary === "string" && summary.trim() !== ""
    ? summary.trim()
    : email.subject;

  const who = await senderLabel(db, email.fromAddr);
  const key = `mail:${rawEmailId}`;
  const push: NotifyInput = priority === "verder"
    ? { kind: "verder-mail", level: "time-sensitive", title: `Verder: ${who}`, body }
    : { kind: "creditor-mail", level: "active", title: who, body };
  await deps.notify({
    ...push, link: "verder://inbox", dedupKey: key, threadId: key, collapseId: key,
  });
}

/**
 * The party whose email is the sender's address, else the display name of a
 * header `senderAddress` accepted, else the bare address. Only called for a
 * header `senderAddress` already resolved (priority is never anything but
 * `other` otherwise), so the display name is the well-formed slice before the
 * one top-level `<`.
 */
async function senderLabel(db: Db, header: string): Promise<string> {
  const addr = senderAddress(header);
  if (addr === null) return header.trim();
  const parties = await db.select({ name: schema.parties.name, email: schema.parties.email })
    .from(schema.parties).where(isNotNull(schema.parties.email));
  const party = parties.find((p) => asciiLower((p.email ?? "").trim()) === addr);
  if (party) return party.name;
  const lt = header.lastIndexOf("<");
  if (lt > 0) {
    let name = header.slice(0, lt).trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
      name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (name) return name;
  }
  return addr;
}
