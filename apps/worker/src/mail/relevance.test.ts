import { describe, expect, it } from "vitest";
import { createDb } from "@verder/db";
import {
  isRelevantMessage, ownMailboxAddresses, relevanceFilter, relevantAddresses,
  sanitizeAddresses,
} from "./relevance";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

describe("isRelevantMessage", () => {
  const addrs = ["@verdergroep.nl", "incasso@stam.nl"];

  it("matches the sender", () => {
    expect(isRelevantMessage(addrs, { from: "Demi <demi@verdergroep.nl>", to: "m@x.nl" }))
      .toBe(true);
  });

  // BOTH directions, always. Testing `from` alone is exactly why none of
  // Martin's outbound post — the whole moratorium package, paspoort,
  // loonstroken, BKR — was ever ingested: 50 inbound emails stored, zero
  // outbound, and every attachment he SENT missing from the vault.
  it("matches the recipient, which is what finds Martin's own sent mail", () => {
    expect(isRelevantMessage(addrs, { from: "martin@vanderpoel.pro", to: "incasso@stam.nl" }))
      .toBe(true);
  });

  it("is case-insensitive on the message side", () => {
    expect(isRelevantMessage(addrs, { from: "Team.Opstart@VerderGroep.NL", to: "" })).toBe(true);
  });

  it("rejects a stranger", () => {
    expect(isRelevantMessage(addrs, { from: "deals@shop.example", to: "promo@shop.example" }))
      .toBe(false);
  });

  // THE TRAP that buildQueries records: no addresses must mean NOTHING is
  // relevant. The opposite reading — "no filter configured, so let it all
  // through" — is the whole-mailbox ingest this filter exists to prevent, and
  // it would arrive as an unremovable ledger event per attachment.
  it("matches nothing at all when there are no addresses to match", () => {
    expect(isRelevantMessage([], { from: "case@verdergroep.nl", to: "martin@vanderpoel.pro" }))
      .toBe(false);
  });

  // FINDING F, and it is a hole straight through the blocker fix. The predicate
  // used to be `"<from> <to>".includes(entry)`, so ONE party row holding a
  // single space made every message in the mailbox relevant — the whole-mailbox
  // ingest, and its unremovable ledger event per attachment, straight back.
  // Sanitising the list is half the cure; the other half is that the predicate
  // itself must be incapable of it, because the list arrives from a table
  // anybody can type into.
  it("cannot be turned into a match-everything by a junk entry", () => {
    expect(isRelevantMessage([" ", "@", "", "."],
      { from: "deals@shop.example", to: "promo@shop.example" })).toBe(false);
  });

  // Substring matching on an address is a lookalike-domain hole: the entry has
  // to be the WHOLE local part or the WHOLE domain, never a tail of either.
  it("does not match an address that merely ends with one we watch", () => {
    expect(isRelevantMessage(["incasso@stam.nl"], { from: "notincasso@stam.nl", to: "" }))
      .toBe(false);
  });

  it("does not match a domain that merely CONTAINS one we watch", () => {
    expect(isRelevantMessage(["@stam.nl"], { from: "Stam <hello@stam.nl.evil.example>", to: "" }))
      .toBe(false);
  });

  it("ignores a header carrying no address at all", () => {
    expect(isRelevantMessage(["@verdergroep.nl"], { from: "undisclosed-recipients", to: "" }))
      .toBe(false);
  });

  // A domain entry names ONE domain. `@stam.nl` must not quietly cover
  // `mail.stam.nl` or `x.stam.nl`: a subdomain is a different mail system, and
  // whoever wanted it can write it out. Locked because `endsWith` is one
  // character away from meaning the opposite.
  it("does not match a SUBDOMAIN of a domain we watch", () => {
    expect(isRelevantMessage(["@stam.nl"], { from: "deurwaarder@mail.stam.nl", to: "" }))
      .toBe(false);
  });

  // FINDING 7's neighbour, on the MESSAGE side. `String.toLowerCase()` is
  // Unicode-aware: U+212A KELVIN SIGN lower-cases to ASCII "k", so a `from`
  // header of `incasso@<KELVIN>vk.nl` folded into `incasso@kvk.nl` and matched
  // the real KvK. The header is text the sender chooses, so that is a stranger
  // letting himself into an append-only dossier. Case-folding must be ASCII and
  // only ASCII; anything else is not an address this filter can name.
  it("does not fold a non-ASCII homoglyph into an address we watch", () => {
    expect(isRelevantMessage(["incasso@kvk.nl"], { from: "incasso@\u212Avk.nl", to: "" }))
      .toBe(false);
  });
});

/**
 * FINDING F at the source. `parties.email` is free text nobody validates, and
 * RELEVANT_SENDERS is an env var a deploy command types by hand. Both feed one
 * list, so both go through one gate.
 *
 * These run without a database on purpose: `parties` is append-only evidence
 * with no DELETE grant for the worker role, so a fixture party carrying a junk
 * email would be PERMANENT residue on the shared dev database — the exact
 * shape of pollution the unique-worker-name rule exists to stop. The party path
 * and the env path hand their values to this same function.
 */
describe("sanitizeAddresses", () => {
  it("throws out a whitespace-only entry, which used to match every message", () => {
    const { addrs, rejected } = sanitizeAddresses([" ", "@verdergroep.nl"], [], "operator");
    expect(addrs).toEqual(["@verdergroep.nl"]);
    expect(rejected).toEqual([{ value: " ", reason: "malformed" }]);
  });

  it("throws out anything that is not an address or an @domain", () => {
    const { addrs, rejected } = sanitizeAddresses(
      ["@", "nobody", "a@b", "two words@x.nl", "@x.nl"], [], "operator");
    expect(addrs).toEqual(["@x.nl"]);
    expect(rejected.map((r) => r.value)).toEqual(["@", "nobody", "a@b", "two words@x.nl"]);
  });

  // A party with no email at all is ordinary — most creditors have none. It is
  // not malformed data and must not be reported as if a human mistyped it, or
  // the rejected list is noise nobody reads.
  it("passes over an empty value without calling it malformed", () => {
    expect(sanitizeAddresses(["", "@x.nl"], [], "operator"))
      .toEqual({ addrs: ["@x.nl"], rejected: [] });
  });

  it("trims, lower-cases and dedupes", () => {
    expect(sanitizeAddresses([" @VerderGroep.NL ", "@verdergroep.nl"], [], "operator").addrs)
      .toEqual(["@verdergroep.nl"]);
  });

  // FINDING 7. The SAME string means two different things depending on who
  // wrote it. `RELEVANT_SENDERS=@verdergroep.nl` is an operator naming a whole
  // organisation and is the documented, intended usage — docs/deploy.md's own
  // example. A bare domain sitting in `parties.email` is DATA: the column is
  // free text, the web UI cannot produce it (parties.ts validates
  // z.string().email()) but the worker seeds insert straight into the table and
  // every row that predates them was never validated at all. One party holding
  // "@gmail.com" or "@ziggo.nl" would open the gate to an entire provider —
  // years of commercial mail, one unremovable `document.ingested` per
  // attachment, on tables with no DELETE grant.
  it("keeps a bare domain from the operator, who meant the whole domain", () => {
    expect(sanitizeAddresses(["@verdergroep.nl"], [], "operator").addrs)
      .toEqual(["@verdergroep.nl"]);
  });

  it("refuses a bare domain that came from a party row", () => {
    const { addrs, rejected } = sanitizeAddresses(["@gmail.com"], [], "party");
    expect(addrs).toEqual([]);
    expect(rejected).toEqual([{ value: "@gmail.com", reason: "party-domain" }]);
  });

  it("keeps a WHOLE address from a party row, which is what that column is for", () => {
    expect(sanitizeAddresses(["Incasso@Stam.nl"], [], "party").addrs)
      .toEqual(["incasso@stam.nl"]);
  });

  // A party row is never comma-split — only RELEVANT_SENDERS is — so a row
  // holding two addresses is one malformed value and matches nothing. Fails
  // CLOSED, which is the only acceptable direction here.
  it("does not split a party row that holds two addresses", () => {
    expect(sanitizeAddresses(["a@b.nl,c@d.nl"], [], "party"))
      .toEqual({ addrs: [], rejected: [{ value: "a@b.nl,c@d.nl", reason: "malformed" }] });
  });

  // The list side of the KELVIN SIGN. `String.toLowerCase()` folded
  // `incasso@<U+212A>vk.nl` into `incasso@kvk.nl`, so a row nobody can read as
  // an address passed the shape check and then matched real KvK mail. ASCII
  // case-folding only: a value with a homoglyph in it is not the address it
  // resembles, and this module exists to distrust the resemblance.
  it("refuses an entry whose non-ASCII character would fold into ASCII", () => {
    const { addrs, rejected } = sanitizeAddresses(["incasso@\u212Avk.nl"], [], "operator");
    expect(addrs).toEqual([]);
    expect(rejected).toEqual([{ value: "incasso@\u212Avk.nl", reason: "malformed" }]);
  });

  // The legitimate instance of the same defect, and the reason this is a
  // rejection rather than a warning: Martin's own address is on EVERY message
  // in his own mailbox, so it is not a wide filter, it is no filter.
  it("refuses the mailbox owner's own address, and says which one", () => {
    const { addrs, rejected } = sanitizeAddresses(
      ["@verdergroep.nl", "Martin@VanderPoel.pro"], ["martin@vanderpoel.pro"], "operator");
    expect(addrs).toEqual(["@verdergroep.nl"]);
    expect(rejected).toEqual([{ value: "martin@vanderpoel.pro", reason: "own-mailbox" }]);
  });

  it("refuses a DOMAIN entry the owner's own address falls under", () => {
    expect(sanitizeAddresses(["@vanderpoel.pro"], ["martin@vanderpoel.pro"], "operator").addrs)
      .toEqual([]);
  });

  it("keeps a domain the owner does not belong to", () => {
    expect(sanitizeAddresses(["@verdergroep.nl"], ["martin@vanderpoel.pro"], "operator").addrs)
      .toEqual(["@verdergroep.nl"]);
  });
});

describe("ownMailboxAddresses", () => {
  const env = { own: process.env.MAIL_OWN_ADDRESSES, user: process.env.JMAP_USER };
  const restore = () => {
    for (const [k, v] of [["MAIL_OWN_ADDRESSES", env.own], ["JMAP_USER", env.user]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  it("includes the JMAP account, whose address is on every message it holds", () => {
    process.env.MAIL_OWN_ADDRESSES = "martin@vanderpoel.pro";
    process.env.JMAP_USER = "Verder@VanderPoel.pro";
    try {
      expect(ownMailboxAddresses()).toEqual(["martin@vanderpoel.pro", "verder@vanderpoel.pro"]);
    } finally { restore(); }
  });

  // JMAP_USER is a login, and a login is not necessarily an address. One that
  // is not must be ignored rather than guessed at.
  it("ignores a JMAP_USER that is not an address", () => {
    process.env.MAIL_OWN_ADDRESSES = "martin@vanderpoel.pro";
    process.env.JMAP_USER = "admin";
    try {
      expect(ownMailboxAddresses()).toEqual(["martin@vanderpoel.pro"]);
    } finally { restore(); }
  });

  // FINDING 8. `??` does not fire on "", so a bare `MAIL_OWN_ADDRESSES=` line
  // in .env.prod — or any wrapper that exports the name with no value — used to
  // drop the hardcoded default silently and leave the own-mailbox protection
  // resting on JMAP_USER alone. An empty value is NOT "this mailbox has no
  // owner": that reading has no legitimate use, while the mistake has an
  // obvious one, so it reads as the mistake it is and the default stands.
  it("keeps the default when MAIL_OWN_ADDRESSES is set but empty", () => {
    process.env.MAIL_OWN_ADDRESSES = "";
    delete process.env.JMAP_USER;
    try {
      expect(ownMailboxAddresses()).toEqual(["martin@vanderpoel.pro"]);
    } finally { restore(); }
  });

  it("keeps the default when MAIL_OWN_ADDRESSES holds only whitespace", () => {
    process.env.MAIL_OWN_ADDRESSES = "  ";
    delete process.env.JMAP_USER;
    try {
      expect(ownMailboxAddresses()).toEqual(["martin@vanderpoel.pro"]);
    } finally { restore(); }
  });
});

describe("relevantAddresses", () => {
  it("carries the configured senders and lower-cases them", async () => {
    const { db, pool } = createDb(URL);
    const before = process.env.RELEVANT_SENDERS;
    process.env.RELEVANT_SENDERS = "@VerderGroep.nl, incasso@Stam.nl";
    try {
      const addrs = await relevantAddresses(db);
      expect(addrs).toContain("@verdergroep.nl");
      expect(addrs).toContain("incasso@stam.nl");
      expect(addrs.every((a) => a === a.toLowerCase())).toBe(true);
    } finally {
      if (before === undefined) delete process.env.RELEVANT_SENDERS;
      else process.env.RELEVANT_SENDERS = before;
      await pool.end();
    }
  });

  // The wiring, on the real query: both sources go through the one gate, and
  // what the gate threw away comes back with the list so pollMail can put it in
  // worker_runs. A filter that quietly narrowed — or nearly widened to the
  // whole mailbox — is otherwise invisible until the vault looks wrong.
  it("drops junk and the owner's own address, and reports both", async () => {
    const { db, pool } = createDb(URL);
    const before = process.env.RELEVANT_SENDERS;
    const beforeOwn = process.env.MAIL_OWN_ADDRESSES;
    process.env.RELEVANT_SENDERS = " , @, @verdergroep.nl, martin@vanderpoel.pro";
    process.env.MAIL_OWN_ADDRESSES = "martin@vanderpoel.pro";
    try {
      const { addrs, rejected } = await relevanceFilter(db);
      expect(addrs).toContain("@verdergroep.nl");
      expect(addrs).not.toContain(" ");
      expect(addrs).not.toContain("@");
      expect(addrs).not.toContain("martin@vanderpoel.pro");
      expect(rejected).toContainEqual({ value: " ", reason: "malformed" });
      expect(rejected).toContainEqual({ value: "@", reason: "malformed" });
      expect(rejected).toContainEqual({
        value: "martin@vanderpoel.pro", reason: "own-mailbox" });
      // relevantAddresses is the same call with the report dropped, which is
      // what keeps pollGmail on exactly this policy without a second spelling.
      expect(await relevantAddresses(db)).toEqual(addrs);
    } finally {
      if (before === undefined) delete process.env.RELEVANT_SENDERS;
      else process.env.RELEVANT_SENDERS = before;
      if (beforeOwn === undefined) delete process.env.MAIL_OWN_ADDRESSES;
      else process.env.MAIL_OWN_ADDRESSES = beforeOwn;
      await pool.end();
    }
  });
});
