import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, schema } from "@verder/db";
import {
  isOwnOutbound, letterSender, mailPriority, prioritySets, type PrioritySets,
} from "./priority";
import { operatorAddresses, relevanceFilter } from "./relevance";

const URL = "postgres://verder_worker:verder_worker@localhost:5432/verder";

const sets: PrioritySets = {
  verder: ["@verdergroep.nl", "@verderbewindmidden.nl"],
  creditorAddresses: ["incasso@stam.nl"],
  own: ["martin@vanderpoel.pro"],
};

describe("mailPriority", () => {
  it("verder domain in from is verder", () => {
    expect(mailPriority(sets, { from: "Demi Willemse <demi@verdergroep.nl>" })).toBe("verder");
    expect(mailPriority(sets, { from: "Team.Opstart@VerderBewindMidden.NL" })).toBe("verder");
  });

  it("subdomain is not verder", () => {
    expect(mailPriority(sets, { from: "x@mail.verdergroep.nl" })).toBe("other");
    expect(mailPriority(sets, { from: "x@verdergroep.nl.evil.tld" })).toBe("other");
    expect(mailPriority(sets, { from: "x@notverdergroep.nl" })).toBe("other");
  });

  // The attack senderAddress was written for: the display name is text the
  // sender chooses, and addressesInHeader would have found the Verder address
  // in it.
  it("display-name spoof of a Verder address is not verder", () => {
    expect(mailPriority(sets, { from: '"demi@verdergroep.nl" <attacker@evil.tld>' }))
      .toBe("other");
    expect(mailPriority(sets, { from: "demi@verdergroep.nl <attacker@evil.tld>" }))
      .toBe("other");
  });

  it("a refused From header is never priority", () => {
    for (const from of [
      "<a@evil.tld> <demi@verdergroep.nl>",
      "demi@verdergroep.nl, a@evil.tld",
      "Groep: <demi@verdergroep.nl>;",
      "demi@verdergroep.nl (Demi)",
      "",
    ]) expect(mailPriority(sets, { from })).toBe("other");
  });

  it("verder in to only is not priority", () => {
    // The input type carries no `to`; a caller passing the whole message must
    // still be judged on `from` alone.
    const msg = { from: "deals@shop.example", to: "demi@verdergroep.nl" };
    expect(mailPriority(sets, msg)).toBe("other");
  });

  it("own outbound to verder is outbound, not priority", () => {
    const msg = { from: "Martin van der Poel <martin@vanderpoel.pro>", to: "demi@verdergroep.nl" };
    expect(isOwnOutbound(sets, msg)).toBe(true);
    expect(mailPriority(sets, msg)).toBe("other");
    expect(isOwnOutbound(sets, { from: "demi@verdergroep.nl" })).toBe(false);
    // A display-name spoof of Martin's own address is not his outbound mail.
    expect(isOwnOutbound(sets, { from: '"martin@vanderpoel.pro" <a@evil.tld>' })).toBe(false);
  });

  it("creditor party email is creditor", () => {
    expect(mailPriority(sets, { from: "Stam Incasso <Incasso@Stam.nl>" })).toBe("creditor");
    expect(mailPriority(sets, { from: "other@stam.nl" })).toBe("other");
  });
});

describe("prioritySets", () => {
  const env = {
    senders: process.env.RELEVANT_SENDERS,
    own: process.env.MAIL_OWN_ADDRESSES,
    user: process.env.JMAP_USER,
  };
  beforeEach(() => {
    delete process.env.RELEVANT_SENDERS;
    process.env.MAIL_OWN_ADDRESSES = "martin@vanderpoel.pro";
    delete process.env.JMAP_USER;
  });
  afterEach(() => {
    for (const [k, v] of [
      ["RELEVANT_SENDERS", env.senders], ["MAIL_OWN_ADDRESSES", env.own], ["JMAP_USER", env.user],
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  // Pins that the two cannot drift: priority's Verder list IS relevance's
  // operator list, default included.
  it("RELEVANT_SENDERS unset uses the same default as relevance", async () => {
    const { db, pool } = createDb(URL);
    try {
      const s = await prioritySets(db);
      expect(s.verder).toEqual(operatorAddresses().addrs);
      expect(s.verder).toEqual(["@verdergroep.nl"]);
      const relevant = (await relevanceFilter(db)).addrs;
      for (const a of s.verder) expect(relevant).toContain(a);
      expect(mailPriority(s, { from: "demi@verdergroep.nl" })).toBe("verder");
    } finally { await pool.end(); }
  });

  it("reads RELEVANT_SENDERS through the one reader, sanitised", async () => {
    process.env.RELEVANT_SENDERS = " @VerderGroep.nl , @verderbewindmidden.nl, , martin@vanderpoel.pro";
    const { db, pool } = createDb(URL);
    try {
      const s = await prioritySets(db);
      expect(s.verder).toEqual(["@verdergroep.nl", "@verderbewindmidden.nl"]);
      expect(s.own).toEqual(["martin@vanderpoel.pro"]);
    } finally { await pool.end(); }
  });

  it("creditors are parties linked to a debt, by either path, and nobody else", async () => {
    const { db, pool } = createDb(URL);
    const tag = crypto.randomUUID();
    try {
      const [viaDebt] = await db.insert(schema.parties).values({
        kind: "organization", name: `Prio Testfixture A ${tag}`, email: `a-${tag}@prio.example`,
      }).returning();
      const [viaEdge] = await db.insert(schema.parties).values({
        kind: "organization", name: `Prio Testfixture B ${tag}`, email: `B-${tag}@Prio.example`,
      }).returning();
      const [unlinked] = await db.insert(schema.parties).values({
        kind: "organization", name: `Prio Testfixture C ${tag}`, email: `c-${tag}@prio.example`,
      }).returning();
      const [debt] = await db.insert(schema.debts).values({
        creditorPartyId: viaDebt.id, creditorName: viaDebt.name,
      }).returning();
      await db.insert(schema.debtParties).values({
        debtId: debt.id, partyId: viaEdge.id, role: "incasso",
      });
      const s = await prioritySets(db);
      expect(s.creditorAddresses).toContain(`a-${tag}@prio.example`);
      expect(s.creditorAddresses).toContain(`b-${tag}@prio.example`);
      expect(s.creditorAddresses).not.toContain(unlinked.email);
      expect(mailPriority(s, { from: `Incasso <b-${tag}@prio.example>` })).toBe("creditor");
      expect(mailPriority(s, { from: `c-${tag}@prio.example` })).toBe("other");
    } finally { await pool.end(); }
  });
});

describe("letterSender", () => {
  const creditors = [
    { partyId: "p-cak", name: "Het CAK" },
    { partyId: "p-stam", name: "Stam Gerechtsdeurwaarders", email: "incasso@stam.nl" },
    { partyId: "p-kvk", name: "Kamer van Koophandel" },
  ];

  it("letter with www.verdergroep.nl is verder", () => {
    const text = "Verder Bewind\nPostbus 123\nwww.verdergroep.nl | 088 123 4567";
    expect(letterSender(sets, text, creditors)).toEqual({ kind: "verder" });
    expect(letterSender(sets, "Mail: opstart@VerderGroep.nl", creditors))
      .toEqual({ kind: "verder" });
    expect(letterSender(sets, "zie https://verdergroep.nl/contact.", creditors))
      .toEqual({ kind: "verder" });
  });

  it("letter mentioning \"verder\" as a word is not", () => {
    expect(letterSender(sets, "Wij gaan verder met de inning. Verder groep.", []))
      .toBeNull();
    expect(letterSender(sets, "www.notverdergroep.nl", [])).toBeNull();
    expect(letterSender(sets, "www.verdergroep.nl.evil.tld", [])).toBeNull();
  });

  it("verder wins over a creditor in the same letter", () => {
    expect(letterSender(sets, "Kamer van Koophandel cc www.verdergroep.nl", creditors))
      .toEqual({ kind: "verder" });
  });

  it("a creditor's email is creditor", () => {
    expect(letterSender(sets, "Reageer aan Incasso@Stam.nl a.u.b.", creditors))
      .toEqual({ kind: "creditor", partyId: "p-stam" });
  });

  // Measured on production 2026-10-31: "ingeschreven bij de Kamer van
  // Koophandel" sits in every contract; the name rule gave 14 false KvK hits.
  it("a creditor's NAME alone is never creditor", () => {
    expect(letterSender(sets, "Afzender: KAMER VAN\nKOOPHANDEL, Utrecht", creditors)).toBeNull();
    expect(letterSender(sets, "ingeschreven bij de Kamer van Koophandel onder nummer 54135591", creditors))
      .toBeNull();
    expect(letterSender(sets, "Factuur van Het CAK", creditors)).toBeNull();
    expect(letterSender(sets, "Hoogachtend, Stam Gerechtsdeurwaarders", creditors)).toBeNull();
  });
});
