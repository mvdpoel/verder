import { createHash, randomInt } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@verder/db";
import { appRouter } from "../root";
import { createContext } from "../trpc";

const APP_URL = "postgres://verder_app:verder_app@localhost:5432/verder";

/**
 * The dev postgres is SHARED — other suites (and earlier runs of this one) have
 * left transactions in it — so not one assertion below is about a total over
 * the table. Both account IBANs and both statement digests are invented FRESH
 * on every run, which is what makes "the series for this account" and "the
 * overig bucket of this month" contain this run's rows and nothing else. An
 * assertion scoped to a fixed IBAN would pass today and start summing two runs
 * together tomorrow.
 *
 * The rows are SHAPED like Martin's situation — salary and rent on a
 * beheerrekening, weekly leefgeld on a leefgeldrekening, the bewind handover in
 * early August — but every amount here is invented. The real figures, measured
 * against a bank statement and cross-checked against a payslip, live in
 * money-series.real.test.ts, which is the oracle for this sub-project. Nothing
 * in this file may be read as evidence about his case.
 */

/** IBAN-shaped (NL + check + 4-letter bank + 10 digits), and unique per run. */
const RUN_DIGITS = String(randomInt(0, 1e10)).padStart(10, "0");
const BEHEER = `NL91ABNA${RUN_DIGITS}`;
const LEEFGELD = `NL42RABO${RUN_DIGITS}`;

const WERKGEVER = "NL22INGB0009876543";
const VERDERGROEP = "NL18ABNA0007654321";
/** Martin's own savings account: the only shape the internal-transfer rule fires on. */
const SPAAR = "NL33ABNA0001112223";
const BELASTINGDIENST = "NL86INGB0002445588";
const WOONHAVE = "NL27ZZZ619752300000";
const SUPERMARKT = "NL63RABO0300111222";

const digest = (label: string) =>
  createHash("sha256").update(`money-${label}-${Date.now()}-${RUN_DIGITS}`).digest("hex");

describe("money router", () => {
  let db: Db; let userId: string;
  let beheerSha: string; let leefgeldSha: string;

  beforeAll(async () => {
    db = createDb(APP_URL).db;
    const [u] = await db.insert(schema.users)
      .values({ email: `money${Date.now()}@test.local`, name: "Martin" }).returning();
    userId = u.id;
    // A real 64-hex digest: documents.sha256 holds one, and the whole point of
    // the discard test below is that the two tables meet on this value.
    beheerSha = digest("beheer");
    leefgeldSha = digest("leefgeld");

    const row = (
      sha: string, account: string, rowIndex: number, day: string, cents: number,
      counterpartyName: string, counterpartyIban: string,
    ) => ({
      source: "abn-camt053" as const, bookedAt: new Date(day), amountCents: cents,
      counterpartyName, counterpartyIban, accountIban: account,
      statementSha256: sha, rowIndex,
    });

    // The beheerrekening: three months of salary and rent. Its statement's last
    // booking is 20 August, so August is not provably complete and July is the
    // newest month the projection is allowed to stand on.
    const beheer = (i: number, day: string, cents: number, name: string, iban: string) =>
      row(beheerSha, BEHEER, i, day, cents, name, iban);
    await db.insert(schema.transactions).values([
      beheer(0, "2026-06-01T00:00:00Z", -174_009, "WOONHAVE BELEGGINGEN", WOONHAVE),
      beheer(1, "2026-06-20T00:00:00Z", 300_000, "Kwartier Software B.V.", WERKGEVER),
      // Money that left and came straight back. Both legs must sit on the SAME
      // account: buildMoneySeries never merges accounts, so a move from beheer
      // to leefgeld is a cost on one card and income on the other by design.
      // What the rule exists for is this — a round trip to Martin's own savings.
      beheer(2, "2026-06-24T00:00:00Z", -50_000, "M VAN DER POEL SPAAR", SPAAR),
      beheer(3, "2026-06-27T00:00:00Z", 50_000, "M VAN DER POEL SPAAR", SPAAR),
      beheer(4, "2026-07-01T00:00:00Z", -181_665, "WOONHAVE BELEGGINGEN", WOONHAVE),
      beheer(5, "2026-07-20T00:00:00Z", 300_000, "Kwartier Software B.V.", WERKGEVER),
      // A belastingteruggave: one credit from a counterparty that pays no
      // cadence, so it is disclosed beside the bar and never inside it.
      beheer(6, "2026-07-27T00:00:00Z", 166_549, "BELASTINGDIENST", BELASTINGDIENST),
      beheer(7, "2026-08-01T00:00:00Z", -181_665, "WOONHAVE BELEGGINGEN", WOONHAVE),
      beheer(8, "2026-08-20T00:00:00Z", 300_000, "Kwartier Software B.V.", WERKGEVER),
    ]);

    // The leefgeldrekening, opened at the bewind handover: weekly leefgeld and
    // groceries, and no month it can speak for from the 1st to the last.
    const leefgeld = (i: number, day: string, cents: number, name: string, iban: string) =>
      row(leefgeldSha, LEEFGELD, i, day, cents, name, iban);
    await db.insert(schema.transactions).values([
      leefgeld(0, "2026-08-03T00:00:00Z", 7_500, "VERDERGROEP BEWINDVOERING", VERDERGROEP),
      leefgeld(1, "2026-08-05T00:00:00Z", -4_200, "ALBERT HEIJN 1234", SUPERMARKT),
      leefgeld(2, "2026-08-10T00:00:00Z", 7_500, "VERDERGROEP BEWINDVOERING", VERDERGROEP),
      leefgeld(3, "2026-08-12T00:00:00Z", -3_850, "ALBERT HEIJN 1234", SUPERMARKT),
      leefgeld(4, "2026-08-17T00:00:00Z", 7_500, "VERDERGROEP BEWINDVOERING", VERDERGROEP),
      leefgeld(5, "2026-08-24T00:00:00Z", 7_500, "VERDERGROEP BEWINDVOERING", VERDERGROEP),
    ]);
  });

  const caller = () => appRouter.createCaller(createContext({ db, userId }));

  async function seriesFor(accountIban: string) {
    const { series } = await caller().money.series();
    const mine = series.find((s) => s.accountIban === accountIban);
    if (!mine) throw new Error(`no series for ${accountIban}`);
    return mine;
  }

  const monthOf = (s: Awaited<ReturnType<typeof seriesFor>>, month: string) => {
    const m = s.months.find((x) => x.month === month);
    if (!m) throw new Error(`no month ${month}`);
    return m;
  };

  it("keeps the two accounts apart, each with its own income", async () => {
    // The point of the whole account dimension. Under bewind Martin's money
    // moves between a beheerrekening and a leefgeldrekening, and one merged
    // stream would draw a collapse at the handover that never happened — so the
    // leefgeld must appear as income on the account that receives it and
    // NOWHERE else. A single series, or an August bar of € 3.300,00 on either
    // card, is the failure this asserts against.
    const { series, accountLabels } = await caller().money.series();
    const mine = series.filter((s) => s.accountIban === BEHEER || s.accountIban === LEEFGELD);
    expect(mine.map((s) => s.accountIban)).toEqual([BEHEER, LEEFGELD].sort());

    const beheer = await seriesFor(BEHEER);
    const leefgeld = await seriesFor(LEEFGELD);
    expect(beheer.months.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(leefgeld.months.map((m) => m.month)).toEqual(["2026-08"]);
    expect(monthOf(beheer, "2026-08").inCents).toBe(300_000);
    expect(monthOf(leefgeld, "2026-08").inCents).toBe(4 * 7_500);

    // Two income lines, one per account, each with its own cadence: a monthly
    // salary and a weekly leefgeld are not the same line and never sum.
    expect(beheer.incomeLines.map((l) => [l.labels.join(" → "), l.cadence]))
      .toEqual([["Kwartier Software B.V.", "monthly"]]);
    expect(leefgeld.incomeLines.map((l) => [l.labels.join(" → "), l.cadence]))
      .toEqual([["VERDERGROEP BEWINDVOERING", "weekly"]]);

    // Until a real source of account names exists an account is shown under its
    // own IBAN — asserted so the page never starts inventing a label.
    expect(accountLabels[BEHEER]).toBe(BEHEER);
    expect(accountLabels[LEEFGELD]).toBe(LEEFGELD);
  });

  it("reports the month's figures, disclosures included", async () => {
    const beheer = await seriesFor(BEHEER);

    const june = monthOf(beheer, "2026-06");
    expect(june.inCents).toBe(300_000);
    // Rent € 1.740,09 plus the € 500,00 that left for the savings account: the
    // debit leg of an internal move is a real payment out and stays in the
    // costs bar. Only its returning credit is held out of income.
    expect(june.outCents).toBe(174_009 + 50_000);
    expect(june.internalCents).toBe(50_000);
    expect(june.incidentalCents).toBe(0);

    const july = monthOf(beheer, "2026-07");
    expect(july.inCents).toBe(300_000);
    expect(july.outCents).toBe(181_665);
    // Income is recurring only. The teruggave is disclosed, not counted — and
    // removing the disclosure is what would make the month stop reconciling.
    expect(july.incidentalCents).toBe(166_549);
    expect(july.internalCents).toBe(0);

    const august = monthOf(beheer, "2026-08");
    expect(august.inCents).toBe(300_000);
    expect(august.outCents).toBe(181_665);

    const leefgeldAugust = monthOf(await seriesFor(LEEFGELD), "2026-08");
    expect(leefgeldAugust.inCents).toBe(4 * 7_500);
    expect(leefgeldAugust.outCents).toBe(4_200 + 3_850);
    expect(leefgeldAugust.incidentalCents).toBe(0);
  });

  it("carries the disclosed rows over the wire, not just their totals", async () => {
    // A cent figure on its own is not a disclosure: Martin cannot tell a
    // belastingteruggave from a credit the rules got wrong unless the page can
    // name the row. These lists are what the footnote under the chart is made
    // of, so they have to survive the procedure, not only the engine.
    const beheer = await seriesFor(BEHEER);
    expect(monthOf(beheer, "2026-06").internalRows.map((r) =>
      [r.counterpartyName, r.amountCents])).toEqual([["M VAN DER POEL SPAAR", 50_000]]);
    expect(monthOf(beheer, "2026-07").incidentalRows.map((r) =>
      [r.counterpartyName, r.amountCents])).toEqual([["BELASTINGDIENST", 166_549]]);
  });

  it("projects from the newest month the statement can vouch for", async () => {
    const beheer = await seriesFor(BEHEER);
    // The statement's last booking is 20 August, so August is hatched, not
    // claimed: a month that is not provably complete never counts as one.
    expect(beheer.months.map((m) => [m.month, m.coverage])).toEqual([
      ["2026-06", "complete"], ["2026-07", "complete"], ["2026-08", "partial"],
    ]);
    expect(beheer.lastCompleteMonth).toBe("2026-07");
    // The first projected month is therefore August — the same month that is
    // already drawn as a partial actual. That overlap is real, and dropping it
    // is money-columns' job, not this router's.
    expect(beheer.projected[0].month).toBe("2026-08");
    expect(beheer.projected[0].inCents).toBe(300_000);

    // The leefgeldrekening's statement starts on the 3rd and stops on the 24th:
    // it can vouch for no whole month, so there is no base to project from and
    // the page shows none rather than a guess.
    const leefgeld = await seriesFor(LEEFGELD);
    expect(monthOf(leefgeld, "2026-08").coverage).toBe("partial");
    expect(leefgeld.lastCompleteMonth).toBeNull();
    expect(leefgeld.projected).toEqual([]);
  });

  it("month detail lists the bank rows behind a category", async () => {
    const detail = await caller().money.month({ accountIban: BEHEER, month: "2026-06" });
    const overig = detail.categories.find((c) => c.category === "overig");
    // Nothing in this run's June is linked to a registry item, so the whole of
    // June's costs pool here — and the bucket holds this account's rows only,
    // which is why an exact figure can be asserted on a shared database.
    expect(overig!.cents).toBe(174_009 + 50_000);
    expect(overig!.transactions.map((t) => t.amountCents).sort((a, b) => a - b))
      .toEqual([-174_009, -50_000]);
    expect(overig!.transactions.every((t) => t.statementSha256 === beheerSha)).toBe(true);
    expect(detail.parseErrorRows).toBe(0);
  });

  it("keeps transactions when their statement document is discarded", async () => {
    // Discard is a status change on the document, never a delete, and the
    // document link is evidence — not ownership of the rows.
    const [doc] = await db.insert(schema.documents).values({
      title: "afschrift.xml", source: "upload", sha256: beheerSha,
      mime: "application/xml", sizeBytes: 10, receivedAt: new Date(),
    }).returning();
    // Through the real procedure, not a raw insert: document_status_changes is
    // an evidence table, and a row appended without its ledger event would make
    // verify.run() red for every later suite on this shared dev database.
    await caller().documents.update({ id: doc.id, status: "discarded" });
    const detail = await caller().money.month({ accountIban: BEHEER, month: "2026-06" });
    const mine = detail.categories
      .flatMap((c) => c.transactions)
      .filter((t) => t.statementSha256 === beheerSha);
    expect(mine.length).toBe(2);
    // And the figures are unchanged: a discarded afschrift does not erase the
    // money it recorded.
    expect(monthOf(await seriesFor(BEHEER), "2026-06").outCents).toBe(174_009 + 50_000);
  });

  it("shows no accounts at all when there are no transactions", async () => {
    // The empty state cannot be proved against the dev postgres: it is shared,
    // it always holds transactions, and a suite that deleted them to see an
    // empty page would be rewriting an append-only evidence table to make a
    // test pass. So the empty DATABASE is stubbed instead — select().from()
    // resolves to no rows, which is exactly what the procedure would read out
    // of a freshly migrated production. The cast is narrow and deliberate:
    // these two procedures touch nothing else on `db`, and effectiveStatuses
    // short-circuits an empty id list without a query. It proves the router's
    // behaviour on no rows, and deliberately claims nothing about the page.
    const emptyDb = {
      select: () => ({
        from: () => Object.assign(Promise.resolve([]), { where: () => Promise.resolve([]) }),
      }),
    } as unknown as Db;
    const empty = appRouter.createCaller(createContext({ db: emptyDb, userId }));

    const { series, accountLabels } = await empty.money.series();
    expect(series).toEqual([]);
    expect(accountLabels).toEqual({});
    // A drill into a month that has no rows must be empty too, not absent: the
    // page links to it from a URL a reader can keep.
    const detail = await empty.money.month({ accountIban: null, month: "2026-06" });
    expect(detail.categories).toEqual([]);
    expect(detail.parseErrorRows).toBe(0);
  });
});
