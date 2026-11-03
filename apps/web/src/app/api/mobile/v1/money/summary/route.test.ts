import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { buildMoneySeries, type MoneyTx } from "@verder/api/src/money-series";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  glance: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

/**
 * Invented rows SHAPED like Martin's situation: a beheerrekening and a
 * leefgeldrekening, weekly leefgeld on the second. Nothing here is evidence
 * about his case — money-series.real.test.ts is the oracle for that.
 */
const BEHEER = "NL91ABNA0000000001";
const LEEFGELD = "NL42RABO0000000002";
const VERDERGROEP = "NL18ABNA0007654321";
const SUPERMARKT = "NL63RABO0300111222";
const BELASTINGDIENST = "NL86INGB0002445588";

let n = 0;
const tx = (account: string | null, day: string, cents: number, name: string, iban: string,
  sha = `sha-${account ?? "none"}`): MoneyTx => ({
  id: `t${String(++n).padStart(3, "0")}`, accountIban: account,
  bookedAt: new Date(`${day}T10:00:00Z`), amountCents: cents,
  counterpartyName: name, counterpartyIban: iban, mandateId: null, parseError: false,
  financialItemId: null, statementSha256: sha,
});

const txs: MoneyTx[] = [
  // Beheerrekening: a debit in the leefgeld week that must NOT touch it, and a
  // one-off credit that /money discloses as incidental.
  tx(BEHEER, "2026-09-01", -50_000, "WOONHAVE", "NL27ZZZ619752300000"),
  tx(BEHEER, "2026-09-15", 120_000, "BELASTINGDIENST", BELASTINGDIENST),
  tx(BEHEER, "2026-10-28", -99_900, "WOONHAVE", "NL27ZZZ619752300000"),
  tx(BEHEER, "2026-10-30", -1_000, "BANKKOSTEN", "NL00ABNA0000000000"),
  // Leefgeldrekening: € 100 every Monday, covered through Friday 30 October.
  ...["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"].map((d) =>
    tx(LEEFGELD, d, 10_000, "VERDERGROEP BEWINDVOERING", VERDERGROEP)),
  tx(LEEFGELD, "2026-10-21", -4_000, "ALBERT HEIJN", SUPERMARKT),
  tx(LEEFGELD, "2026-10-27", -6_240, "ALBERT HEIJN", SUPERMARKT),
  tx(LEEFGELD, "2026-10-30", -1_000, "ALBERT HEIJN", SUPERMARKT),
];
const series = buildMoneySeries({ transactions: txs, items: [] });

/** A month as it arrives over the wire: dates are ISO strings by then. */
type MonthJson = {
  month: string; outCents: number; incidentalCents: number;
  incidentalRows: unknown[]; internalRows: unknown[];
  outRows: number; inSources: unknown[];
};
type Body = {
  accounts: { accountIban: string | null; months: MonthJson[]; newestBooking: string | null; isLeefgeldAccount: boolean }[];
};
const accountOf = (body: Body, iban: string) => {
  const a = body.accounts.find((x) => x.accountIban === iban);
  if (!a) throw new Error(`no account ${iban}`);
  return a;
};

const ctx = { params: Promise.resolve({}) };
const req = () => new Request("http://localhost/api/mobile/v1/money/summary");
const ENV = ["LEEFGELD_WEEKLY_CENTS", "LEEFGELD_IBAN", "LEEFGELD_WEEK_START"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  // Saturday 31 October 2026, 12:00 Amsterdam.
  vi.setSystemTime(new Date("2026-10-31T11:00:00Z"));
  for (const k of ENV) vi.stubEnv(k, "");
  vi.stubEnv("LEEFGELD_WEEKLY_CENTS", "10000");
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ money: { glance: mocks.glance } });
  mocks.glance.mockResolvedValue({ series, txs, newestBooking: "2026-10-30" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/mobile/v1/money/summary", () => {
  it("401 first", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.serverCaller).not.toHaveBeenCalled();
    expect(mocks.glance).not.toHaveBeenCalled();
  });

  it("accounts are listed separately", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    // One entry per account, never a total across them.
    // In the series' own order (sorted by IBAN), never re-ranked here.
    expect(body.accounts.map((a: { accountIban: string }) => a.accountIban))
      .toEqual(series.map((s) => s.accountIban));
    expect(body.accounts.map((a: { accountIban: string }) => a.accountIban).sort())
      .toEqual([BEHEER, LEEFGELD].sort());
    expect(Object.keys(body).sort()).toEqual(["accounts", "leefgeld", "newestBooking", "previousWeek"]);
    const beheer = accountOf(body, BEHEER);
    // The last six months only, the series' own objects.
    expect(beheer.months.map((m: { month: string }) => m.month))
      .toEqual(["2026-09", "2026-10"]);
    expect(beheer.months[1].outCents).toBe(99_900 + 1_000);

    // The leefgeld week is the leefgeldrekening's alone: the beheer debits of
    // 28 and 30 October do not reach it.
    // The statement stops on Friday 30 October and today is Saturday: the week
    // is partial, through the last day the statement can vouch for.
    expect(body.leefgeld).toMatchObject({
      state: "partial", accountIban: LEEFGELD, accountReason: "weekly-income",
      week: { from: "2026-10-26", to: "2026-11-01" }, coveredThrough: "2026-10-30",
      budgetCents: 10_000, spentCents: 6_240 + 1_000, leftCents: 10_000 - 7_240,
      depositCents: 10_000,
    });
    // Spent is summed from its own rows, and they travel with it.
    expect(body.leefgeld.spentRows.map((r: { amountCents: number }) => r.amountCents))
      .toEqual([-6_240, -1_000]);
    // The previous week is judged WHOLE (through its own Sunday), on the same read.
    expect(body.previousWeek).toMatchObject({
      state: "complete", week: { from: "2026-10-19", to: "2026-10-25" },
      coveredThrough: "2026-10-25", spentCents: 4_000, depositCents: 10_000,
    });
    expect(body.newestBooking).toBe("2026-10-30");
    // Each account carries its OWN newest booking and whether it is the
    // leefgeldrekening (here recognised by its weekly income).
    expect(Object.keys(beheer).sort()).toEqual(["accountIban", "isLeefgeldAccount", "months", "newestBooking"]);
    expect(beheer).toMatchObject({ newestBooking: "2026-10-30", isLeefgeldAccount: false });
    expect(accountOf(body, LEEFGELD)).toMatchObject({ newestBooking: "2026-10-30", isLeefgeldAccount: true });
    expect(mocks.glance).toHaveBeenCalledTimes(1);
  });

  it("missing env gives no-budget", async () => {
    vi.unstubAllEnvs();
    for (const k of ENV) delete process.env[k];
    const body = await (await GET(req(), ctx)).json();
    expect(body.leefgeld).toEqual({ state: "no-budget" });
    expect(body.previousWeek).toEqual({ state: "no-budget" });
    // The accounts are still there: the budget gates the figure, not the page.
    expect(body.accounts).toHaveLength(2);
    // With no budget and no LEEFGELD_IBAN nothing recognises the leefgeldrekening.
    expect(body.accounts.map((a: { isLeefgeldAccount: boolean }) => a.isLeefgeldAccount)).toEqual([false, false]);
    // LEEFGELD_IBAN names it even without a weekly amount.
    vi.stubEnv("LEEFGELD_IBAN", LEEFGELD);
    expect(accountOf(await (await GET(req(), ctx)).json(), LEEFGELD).isLeefgeldAccount).toBe(true);
    vi.stubEnv("LEEFGELD_IBAN", "");

    // A value that is not a whole number of cents is no budget either, never 0.
    for (const bad of ["", "100,00", "-5", "1e4", "abc"]) {
      vi.stubEnv("LEEFGELD_WEEKLY_CENTS", bad);
      expect((await (await GET(req(), ctx)).json()).leefgeld).toEqual({ state: "no-budget" });
    }
  });

  it("configured IBAN and week start are read from the environment", async () => {
    vi.stubEnv("LEEFGELD_IBAN", ` ${LEEFGELD} `);
    vi.stubEnv("LEEFGELD_WEEK_START", "4");
    const body = await (await GET(req(), ctx)).json();
    expect(body.leefgeld).toMatchObject({
      accountIban: LEEFGELD, accountReason: "configured",
      week: { from: "2026-10-29", to: "2026-11-04" },
    });
    // An out-of-range weekday falls back to Monday rather than inventing one.
    vi.stubEnv("LEEFGELD_WEEK_START", "9");
    expect((await (await GET(req(), ctx)).json()).leefgeld.week)
      .toEqual({ from: "2026-10-26", to: "2026-11-01" });
  });

  it("months keep their disclosure rows", async () => {
    const body = await (await GET(req(), ctx)).json();
    const september = accountOf(body, BEHEER).months[0];
    expect(september.incidentalCents).toBe(120_000);
    expect(september.incidentalRows).toEqual([{
      id: expect.any(String), bookedAt: "2026-09-15T10:00:00.000Z",
      amountCents: 120_000, counterpartyName: "BELASTINGDIENST",
    }]);
    expect(september.internalRows).toEqual([]);
  });

  it("each month says how many bookings its bars hold and who paid in", async () => {
    const body = await (await GET(req(), ctx)).json();
    const [sep, oct] = accountOf(body, BEHEER).months;
    // The debits under the spending bar, counted by the bar's own filter.
    expect(sep.outRows).toBe(1);
    expect(oct.outRows).toBe(2);
    // A one-off from a stranger is no income line, so it names no source.
    expect(sep.inSources).toEqual([]);
    const leefOct = accountOf(body, LEEFGELD).months.find((m) => m.month === "2026-10");
    if (!leefOct) throw new Error("no October on the leefgeldrekening");
    expect(leefOct.outRows).toBe(3);
    // The weekly payer is a stranger here: named, but never as an own account.
    expect(leefOct.inSources).toEqual([
      { label: "VERDERGROEP BEWINDVOERING", count: 4, cadence: "weekly", fromAccountIban: null },
    ]);

    // The beheerrekening paying the leefgeld is named as an OWN account.
    const own = [
      tx(BEHEER, "2026-10-01", -2_000, "BANKKOSTEN", "NL00ABNA0000000000"),
      ...["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"].map((d) =>
        tx(LEEFGELD, d, 10_000, "M. EIGEN", BEHEER)),
    ];
    mocks.glance.mockResolvedValue({
      series: buildMoneySeries({ transactions: own, items: [] }), txs: own, newestBooking: "2026-10-26",
    });
    const body2 = await (await GET(req(), ctx)).json();
    expect(accountOf(body2, LEEFGELD).months[0].inSources).toEqual([
      { label: "M. EIGEN", count: 4, cadence: "weekly", fromAccountIban: BEHEER },
    ]);
  });

  it("an empty table answers geen data, never a figure", async () => {
    mocks.glance.mockResolvedValue({ series: [], txs: [], newestBooking: null });
    vi.stubEnv("LEEFGELD_IBAN", LEEFGELD);
    const body = await (await GET(req(), ctx)).json();
    expect(body.accounts).toEqual([]);
    expect(body.newestBooking).toBeNull();
    expect(body.leefgeld).toEqual({
      state: "geen-data", accountIban: LEEFGELD, accountReason: "configured",
      week: { from: "2026-10-26", to: "2026-11-01" }, newestBooking: null,
    });
  });

  it("401 maps from a router UNAUTHORIZED", async () => {
    mocks.glance.mockRejectedValue(new TRPCError({ code: "UNAUTHORIZED" }));
    expect((await GET(req(), ctx)).status).toBe(401);
  });
});
