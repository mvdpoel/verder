import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  requestActivity, requestFailureDetail, requestFailureText, requestProgress, type ActivityLogLike,
} from "@grip/api/src/request-progress";
import { requestListItem, requestName, requestThreads, type RequestThreadRow } from "@grip/api/src/request-threads";
import { waitingOnMartin, type ProposalRow } from "@grip/api/src/waiting";
import { toInboxDTO } from "./mobile-dto";
import { toRequestDTO, toRequestListItemDTO, type RequestDetailSource, type RequestSourceDetail } from "./mobile-requests";

/**
 * The phone's Vraag Grip fixtures ARE the server's own rules over a synthetic
 * case — the names of docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md,
 * all invented — so what the simulator draws can never drift from what the
 * routes serve:
 *
 *   - each state's `requests.json` is `requestThreads` → `requestListItem` →
 *     the list DTO, over that state's request rows;
 *   - each state's `inbox.json` is `waitingOnMartin` → `toInboxDTO` over the
 *     same rows plus Ilse's loonstrook proposal — so the FOLDING RULE (a
 *     question's proposal is carried by its row and not listed apart; "Laat
 *     maar" releases it) and the FAILED-WAITS rule are what the fixtures show,
 *     not what someone typed;
 *   - progress lines, activity steps and failure words come from the real
 *     functions the router uses.
 *
 * One folder per state of the final Figma frames ("Vraag Grip · it6"); every
 * request has its own id, so a state is the set of rows it lists. The detail
 * files are shared (`_shared/requests/<id>.json`).
 *
 * Regenerate with `WRITE_FIXTURES=1 pnpm --filter web test mobile-requests.fixture`.
 */

const FIXTURES = fileURLToPath(new URL("../../../ios/Grip/FixtureData/", import.meta.url));
const SHARED = `${FIXTURES}_shared/`;
const R = (n: string) => `00000000-f1c5-4000-8000-a000000000${n}`;
const C = (n: string) => `6f0b7c1e-2a3d-4e5f-8a9b-0c1d2e3f40${n}`;
const P = (n: string) => `00000000-f1c5-4000-8000-0000000000${n}`;
const DOC = (n: number) => `00000000-f1c5-4000-8000-200000000${n}`;
const TX = (n: number) => `00000000-f1c5-4000-8000-70000000000${n}`;
const MAIL_BOEDEL = "00000000-f1c5-4000-8000-400000000202";
const GMAIL_STUKKEN = "18f2a0c4d5e6f701";
const P_ILSE = "00000000-f1c5-4000-8000-000000000001";
const PARTY_NOORDKUST = "00000000-f1c5-4000-8000-600000000002";
/** Monday 2 November 2026, Amsterdam (CET, UTC+1): "14:03" is 13:03Z. */
const nov = (day: number, local: string) => {
  const [h, m] = local.split(":").map(Number);
  return new Date(Date.UTC(2026, 10, day, h - 1, m));
};
const okt = (day: number, local: string) => {
  const [h, m] = local.split(":").map(Number);
  return new Date(Date.UTC(2026, 9, day, h - 2 + (day >= 25 ? 1 : 0), m));
};
const call = (tool: string, ids: { type: string; id: string }[] = [], error?: string): ActivityLogLike =>
  ({ tool, ids, ...(error ? { error } : {}) });

// --- The words ---------------------------------------------------------------

const BOEDEL_Q = "Wat moet ik antwoorden op de boedelbeschrijving van Noordkust? Check de feiten.";
const BOEDEL_ANSWER = [
  "Ik heb de boedelbeschrijving naast je dossier gelegd. Dit mist Noordkust nog:",
  "",
  "• Je huurcontract met Woonstichting Lindehof.",
  "• De vordering van Kade & Partners: € 420,00, sommatie van 14 okt.",
  "",
  "De rest klopt met wat Noordkust al heeft. Ik heb een antwoord aan Ilse klaargezet, met beide als bijlage.",
].join("\n");
const BOEDEL_STEP = "Check of je huurcontract van 2025 nog het nieuwste is.";
const FOLLOW_Q = "Voeg ook mijn loonstrook van oktober toe.";
const GIFT_Q = "Zeg mijn maandelijkse gift aan Stichting Lindeboom op.";
const GIFT_ANSWER = [
  "Stichting Lindeboom schrijft elke maand € 10,00 af van je leefgeldrekening, het laatst op 2 okt.",
  "",
  "Die rekening beheer je zelf, dus opzeggen doe je in je bank-app. Een mail aan de stichting heb ik niet klaargezet: er staat geen adres in je dossier.",
  "",
  "Wil je dat Noordkust het weet? Vraag door, dan zet ik een mail aan Ilse klaar.",
].join("\n");
const GIFT_STEP = "Trek de machtiging in via je bank-app: Incasso’s › Stichting Lindeboom.";

// --- Sources, as the router resolves them -------------------------------------

const src = {
  mail: { type: "mail", id: MAIL_BOEDEL, why: "Ilse stuurde de boedelbeschrijving om in te vullen.",
    label: "Boedelbeschrijving invullen", meta: ["Mail", "In dossier", "Ilse"], at: nov(2, "08:40").toISOString(), inDossier: true },
  huur: { type: "document", id: DOC(304), why: "Dit huurcontract ontbreekt nog bij Noordkust.",
    label: "Huurcontract Lindehof", meta: ["Dossier", "contract"], at: "2025-03-01T09:00:00.000Z", inDossier: true },
  sommatie: { type: "document", id: DOC(106), why: "De vordering die Noordkust nog niet kent.",
    label: "Sommatie Kade & Partners", meta: ["Dossier", "letter"], at: "2026-10-14T09:00:00.000Z", inDossier: true },
  gmail: { type: "gmail", id: GMAIL_STUKKEN, why: "Ilse vroeg eerder om het huurcontract.",
    label: "Re: Aanvullende stukken", meta: ["Gmail", "Niet in je dossier"], at: okt(20, "10:12").toISOString(), inDossier: false,
    gmail: { from: "Ilse <ilse@noordkust.example>", to: "jou", subject: "Re: Aanvullende stukken",
      date: okt(20, "10:12").toISOString(),
      body: "Beste,\n\nVoor de boedelbeschrijving hebben we nog een kopie van uw huurcontract nodig. Wilt u die samen met de ingevulde lijst terugsturen?\n\nMet vriendelijke groet,\nIlse\nBewindkantoor Noordkust" } },
  loonstrook: { type: "document", id: DOC(104), why: "De loonstrook die je wilde meesturen.",
    label: "Loonstrook 2026-10", meta: ["Dossier", "payslip"], at: "2026-10-28T09:00:00.000Z", inDossier: true },
  tx: (n: number, day: number, month: number): RequestSourceDetail => ({
    type: "transaction", id: TX(n), why: "De maandelijkse gift.", label: "Stichting Lindeboom", meta: [],
    at: new Date(Date.UTC(2026, month - 1, day, 9, 0)).toISOString(), inDossier: true,
    transaction: { amountCents: -1000, bookedAt: new Date(Date.UTC(2026, month - 1, day, 9, 0)).toISOString(),
      counterparty: "Stichting Lindeboom", accountIban: "NL00TEST9876543210", description: "Maandelijkse gift", mandate: true } }),
};

const card = (id: string, o: Partial<RequestDetailSource["proposal"] & object> = {}) => ({
  id, status: "pending", kind: "reply", priority: "verder", title: "Antwoord aan Bewindkantoor Noordkust",
  to: ["ilse@noordkust.example"], subject: "Re: Boedelbeschrijving", attachmentCount: 2, sentAt: null, ...o,
});

// --- The rows ------------------------------------------------------------------

interface Req { row: RequestThreadRow; detail: Partial<RequestDetailSource>; log?: ActivityLogLike[]; error?: string;
  claimedAt?: Date; about?: RequestDetailSource["about"] }

const aboutBoedel = { type: "mail", id: MAIL_BOEDEL, label: "Boedelbeschrijving invullen", meta: ["Ilse"],
  at: nov(2, "08:40").toISOString() };
const row = (o: Partial<RequestThreadRow> & Pick<RequestThreadRow, "id" | "text" | "status" | "createdAt">): RequestThreadRow => ({
  parentRequestId: null, title: null, answeredAt: null, openedAt: null, dismissedAt: null, updatedAt: o.answeredAt ?? o.createdAt,
  martinSteps: [], stepsDone: {}, proposal: null, ...o,
});
const pending = (id: string, status = "pending") => ({ id, status, priority: "verder" });
const workLog = [call("get_document"), call("get_document"), call("get_document"), call("get_document"),
  call("list_mail", [{ type: "mail", id: MAIL_BOEDEL }, { type: "mail", id: "00000000-f1c5-4000-8000-400000000201" },
    { type: "mail", id: "00000000-f1c5-4000-8000-400000000021" }]), call("gmail_search")];
const failLog = [...workLog.slice(0, 5), call("gmail_search", [], "gmail: rate limited")];
const boedel = { text: BOEDEL_Q, title: "Boedelbeschrijving Noordkust", createdAt: nov(2, "14:03") };
const answeredBoedel = { ...boedel, status: "answered", answeredAt: nov(2, "14:06"), martinSteps: [BOEDEL_STEP] };
const boedelDetail = { headline: "Er ontbreken twee dingen", answer: BOEDEL_ANSWER,
  sources: [src.mail, src.huur, src.sommatie, src.gmail], proposal: card(P("c1")) };

const reqs: Record<string, Req> = {
  queued: { row: row({ id: R("01"), ...boedel, title: null, status: "queued" }), detail: {}, about: aboutBoedel },
  working: { row: row({ id: R("02"), ...boedel, title: null, status: "working" }), detail: {}, log: workLog,
    claimedAt: nov(2, "14:03"), about: aboutBoedel },
  unread: { row: row({ id: R("03"), ...answeredBoedel, proposal: pending(P("c1")) }), detail: boedelDetail,
    log: workLog, claimedAt: nov(2, "14:03"), about: aboutBoedel },
  read: { row: row({ id: R("04"), ...answeredBoedel, openedAt: nov(2, "14:07"), proposal: pending(P("c1")) }),
    detail: boedelDetail, log: workLog, claimedAt: nov(2, "14:03"), about: aboutBoedel },
  failed: { row: row({ id: R("05"), ...boedel, title: null, status: "failed", updatedAt: nov(2, "14:20") }), detail: {},
    log: failLog, error: "runner: timeout after 600 s", claimedAt: nov(2, "14:10"), about: aboutBoedel },
  stopped: { row: row({ id: R("06"), ...boedel, title: null, status: "cancelled", updatedAt: nov(2, "14:05") }), detail: {},
    about: aboutBoedel },
  putAway: { row: row({ id: R("07"), ...answeredBoedel, openedAt: nov(2, "14:07"), dismissedAt: nov(2, "14:30"),
    proposal: pending(P("c1")) }), detail: boedelDetail, log: workLog, claimedAt: nov(2, "14:03"), about: aboutBoedel },
  // Vraag door, being researched: version 1 is being rewritten.
  rootUpdating: { row: row({ id: R("08"), ...answeredBoedel, openedAt: nov(2, "14:07"), proposal: pending(P("c1")) }),
    detail: boedelDetail, log: workLog, claimedAt: nov(2, "14:03"), about: aboutBoedel },
  followWorking: { row: row({ id: R("09"), text: FOLLOW_Q, parentRequestId: R("08"), status: "working",
    createdAt: nov(2, "14:12") }), detail: {}, log: [call("get_document", [{ type: "document", id: DOC(104) }])],
    claimedAt: nov(2, "14:12") },
  // Vraag door, answered: version 2.
  rootV2: { row: row({ id: R("0a"), ...answeredBoedel, openedAt: nov(2, "14:07"), proposal: pending(P("c1"), "superseded") }),
    detail: { ...boedelDetail, proposal: card(P("c1"), { status: "superseded" }) }, log: workLog, claimedAt: nov(2, "14:03"),
    about: aboutBoedel },
  followV2: { row: row({ id: R("0b"), text: FOLLOW_Q, parentRequestId: R("0a"), status: "answered", title: "Loonstrook toegevoegd",
    createdAt: nov(2, "14:12"), answeredAt: nov(2, "14:13"), proposal: pending(P("c2")) }),
    detail: { headline: "Loonstrook toegevoegd",
      answer: "Het antwoord aan Ilse heeft nu drie bijlagen: het huurcontract, de sommatie en je loonstrook van oktober.",
      sources: [src.loonstrook], proposal: card(P("c2"), { attachmentCount: 3 }) },
    log: [call("get_document", [{ type: "document", id: DOC(104) }])], claimedAt: nov(2, "14:12") },
  // Vraag door after version 1 was already sent: a NEW proposal.
  rootSent: { row: row({ id: R("0c"), ...answeredBoedel, openedAt: nov(2, "14:07"), proposal: pending(P("c3"), "sent") }),
    detail: { ...boedelDetail, proposal: card(P("c3"), { status: "sent", sentAt: nov(2, "14:10") }) }, log: workLog,
    claimedAt: nov(2, "14:03"), about: aboutBoedel },
  followNew: { row: row({ id: R("0d"), text: FOLLOW_Q, parentRequestId: R("0c"), status: "answered", title: "Nieuw bericht klaargezet",
    createdAt: nov(2, "14:12"), answeredAt: nov(2, "14:13"), proposal: pending(P("c4")) }),
    detail: { headline: "Nieuw bericht klaargezet",
      answer: "Je eerste antwoord aan Ilse is om 14:10 al verstuurd, dus dat pas ik niet meer aan. Ik heb een kort nieuw bericht klaargezet met alleen je loonstrook van oktober.",
      sources: [src.loonstrook], proposal: card(P("c4"), { kind: "compose", title: "Aanvulling aan Bewindkantoor Noordkust",
        attachmentCount: 1 }) },
    log: [call("get_document", [{ type: "document", id: DOC(104) }])], claimedAt: nov(2, "14:12") },
  gift: { row: row({ id: R("10"), text: GIFT_Q, title: "Gift Stichting Lindeboom opzeggen", status: "answered",
    createdAt: nov(2, "15:18"), answeredAt: nov(2, "15:20"), openedAt: nov(2, "15:21"), martinSteps: [GIFT_STEP] }),
    detail: { headline: "De incasso loopt nog", answer: GIFT_ANSWER,
      sources: [src.tx(1, 2, 10), src.tx(2, 2, 9), src.tx(3, 2, 8)] },
    log: [call("list_transactions"), call("list_parties")], claimedAt: nov(2, "15:18") },
  giftDone: { row: row({ id: R("11"), text: GIFT_Q, title: "Gift Stichting Lindeboom opzeggen", status: "answered",
    createdAt: nov(2, "15:18"), answeredAt: nov(2, "15:20"), openedAt: nov(2, "15:21"), martinSteps: [GIFT_STEP],
    stepsDone: { 0: nov(2, "15:42").toISOString() } }),
    detail: { headline: "De incasso loopt nog", answer: GIFT_ANSWER,
      sources: [src.tx(1, 2, 10), src.tx(2, 2, 9), src.tx(3, 2, 8)] },
    log: [call("list_transactions"), call("list_parties")], claimedAt: nov(2, "15:18") },
  leefgeld: { row: row({ id: R("12"), text: "Wanneer komt mijn leefgeld deze week?", title: "Wanneer komt mijn leefgeld?",
    status: "answered", createdAt: okt(30, "09:10"), answeredAt: okt(30, "09:12"), openedAt: okt(30, "09:20") }),
    detail: { headline: "Vrijdag, zoals elke week",
      answer: "Noordkust maakt je leefgeld elke vrijdag over. Deze week staat er geen uitzondering in je dossier." },
    claimedAt: okt(30, "09:10") },
  duinzorg: { row: row({ id: R("13"), text: "Zoek de polis van Duinzorg en kijk of de premie al is aangepast.",
    title: "Polis Duinzorg 2026", status: "cancelled", createdAt: okt(28, "19:58"), updatedAt: okt(28, "20:02") }), detail: {} },
  loonstroken: { row: row({ id: R("14"), text: "Welke loonstroken heeft Team Startdossier al van me gekregen?",
    title: "Loonstroken voor Team Startdossier", status: "answered", createdAt: okt(26, "11:00"), answeredAt: okt(26, "11:03"),
    openedAt: okt(26, "11:05") }),
    detail: { headline: "Juli tot en met september",
      answer: "Team Startdossier heeft je loonstroken van juli, augustus en september. Die van oktober nog niet." },
    claimedAt: okt(26, "11:00") },
};

// "Eerdere vragen · 3 klaar" in the ordinary states.
const earlier = [reqs.leefgeld, reqs.duinzorg, reqs.loonstroken];

function detailOf(q: Req, all: Req[]): RequestDetailSource {
  const r = q.row;
  const threads = requestThreads(all.map((x) => x.row));
  const t = threads.find((x) => x.members.some((m) => m.id === r.id));
  const head = t?.head.id === r.id ? t : null;
  const log = q.log ?? [];
  const progress = requestProgress(log);
  const live = r.status === "queued" || r.status === "working";
  const answered = r.status === "answered";
  const ancestors = all.filter((x) => x.row.id === r.parentRequestId);
  const carried = head?.carried ?? null;
  return {
    id: r.id, rootId: t?.root.id ?? r.id, clientId: C(r.id.slice(-2)), text: r.text, status: r.status,
    title: t?.title ?? requestName(r.title ?? r.text), headline: answered ? q.detail.headline ?? null : null,
    phase: head?.phase ?? null, todoReason: head?.todoReason ?? null, doneReason: head?.doneReason ?? null,
    parentRequestId: r.parentRequestId,
    createdAt: r.createdAt, claimedAt: q.claimedAt ?? null, answeredAt: r.answeredAt, openedAt: r.openedAt,
    dismissedAt: r.dismissedAt, updatedAt: r.updatedAt,
    unread: answered && r.openedAt === null,
    progressLine: r.status === "working" ? progress.line : null,
    failure: r.status === "failed" ? requestFailureText(q.error ?? null) : null,
    failureDetail: r.status === "failed" ? requestFailureDetail(q.error ?? null) : null,
    about: q.about ?? null,
    answer: answered ? q.detail.answer ?? null : null,
    sources: answered ? q.detail.sources ?? [] : [],
    martinSteps: answered ? r.martinSteps : [],
    steps: answered ? r.martinSteps.map((text, index) => ({ index, text, doneAt: r.stepsDone[String(index)] ?? null })) : [],
    proposal: q.detail.proposal ?? (live && carried ? ancestors[0]?.detail.proposal ?? null : null),
    proposalUpdating: live && !q.detail.proposal && carried !== null,
    progress: live || r.status === "failed"
      ? { calls: progress.calls, documents: progress.documents, mails: progress.mails, gmail: progress.gmail,
        line: progress.line, steps: requestActivity(log, r.status === "failed") }
      : null,
    thread: ancestors.map((a) => ({ id: a.row.id, text: a.row.text, status: a.row.status, createdAt: a.row.createdAt,
      title: requestName(a.row.title ?? a.row.text), headline: a.row.status === "answered" ? a.detail.headline ?? null : null,
      answer: a.row.status === "answered" ? a.detail.answer ?? null : null, proposal: a.detail.proposal ?? null })),
    followUps: all.filter((x) => x.row.parentRequestId === r.id)
      .map((x) => ({ id: x.row.id, text: x.row.text, status: x.row.status, createdAt: x.row.createdAt })),
  };
}

// --- Voor jou: the inbox around the questions ----------------------------------

const ilse: ProposalRow = {
  id: P_ILSE, kind: "reply", priority: "verder", createdAt: new Date("2026-11-02T07:30:00.000Z"),
  payload: { ask: "Antwoord aan Bewindkantoor Noordkust: loonstrook oktober" }, partyName: "Bewindkantoor Noordkust",
  partyId: PARTY_NOORDKUST, senderGuess: null, triggerRequestId: null,
};
const boedelProposal = (id: string, requestId: string): ProposalRow => ({
  id, kind: "reply", priority: "verder", createdAt: nov(2, "14:06"),
  payload: { ask: "Antwoord aan Bewindkantoor Noordkust" }, partyName: "Bewindkantoor Noordkust",
  partyId: PARTY_NOORDKUST, senderGuess: null, triggerRequestId: requestId,
});
const doneByGrip = (JSON.parse(readFileSync(`${FIXTURES}voorjou-een/inbox.json`, "utf8")) as { doneByGrip: unknown[] }).doneByGrip;

interface State { name: string; description: string; today: Date; rows: Req[]; proposals: ProposalRow[]; extra?: object }
const states: State[] = [
  { name: "vraag-overzicht", description: "Overzicht on Mon 2 nov 14:02 with one thing waiting (Ilse's loonstrook) and the Vraag Grip capsule; three earlier questions done.",
    today: nov(2, "14:02"), rows: earlier, proposals: [ilse] },
  { name: "vraag-wachtrij", description: "Vraag Grip: the boedelbeschrijving question queued at 14:03 (Voor jou · in de wachtrij).",
    today: nov(2, "14:04"), rows: [reqs.queued, ...earlier], proposals: [ilse] },
  { name: "vraag-bezig", description: "Vraag Grip: Grip researching the boedelbeschrijving question, 2 min in.",
    today: nov(2, "14:05"), rows: [reqs.working, ...earlier], proposals: [ilse] },
  { name: "vraag-netwerk", description: "Vraag Grip: offline; the question waits on the phone (seed with -fixtures-vraag netwerk).",
    today: nov(2, "14:02"), rows: earlier, proposals: [ilse], extra: { thenFail: "offline" } },
  { name: "vraag-ongelezen", description: "Vraag Grip: the answer is in, unread, with a proposal folded into its row (2 wachten).",
    today: nov(2, "14:06"), rows: [reqs.unread, ...earlier], proposals: [ilse, boedelProposal(P("c1"), R("03"))] },
  { name: "vraag-gelezen", description: "Vraag Grip: the answer read; its proposal and one step still wait on you.",
    today: nov(2, "14:08"), rows: [reqs.read, ...earlier], proposals: [ilse, boedelProposal(P("c1"), R("04"))] },
  { name: "vraag-bijgewerkt", description: "Vraag Grip: a follow-up rewrites the proposal; the thread waits on Grip (1 wacht).",
    today: nov(2, "14:13"), rows: [reqs.rootUpdating, reqs.followWorking, ...earlier], proposals: [ilse, boedelProposal(P("c1"), R("08"))] },
  { name: "vraag-vervolg", description: "Vraag Grip: the follow-up answered with version 2 of the proposal.",
    today: nov(2, "14:14"), rows: [reqs.rootV2, reqs.followV2, ...earlier], proposals: [ilse, boedelProposal(P("c2"), R("0b"))] },
  { name: "vraag-verstuurd", description: "Vraag Grip: the follow-up after version 1 was sent — a new proposal.",
    today: nov(2, "14:14"), rows: [reqs.rootSent, reqs.followNew, ...earlier], proposals: [ilse, boedelProposal(P("c4"), R("0d"))] },
  { name: "vraag-mislukt", description: "Vraag Grip: the question failed at 14:20 and waits on you (Opnieuw proberen).",
    today: nov(2, "14:20"), rows: [reqs.failed, ...earlier], proposals: [ilse] },
  { name: "vraag-gestopt", description: "Vraag Grip: you stopped the question at 14:05.",
    today: nov(2, "14:06"), rows: [reqs.stopped, ...earlier], proposals: [ilse] },
  { name: "vraag-laatmaar", description: "Vraag Grip: after Laat maar — the question put away, its proposal released as its own row.",
    today: nov(2, "14:30"), rows: [reqs.putAway, ...earlier], proposals: [ilse, boedelProposal(P("c1"), R("07"))] },
  { name: "vraag-gift", description: "Vraag Grip: the Lindeboom gift answered without a proposal, one step for you.",
    today: nov(2, "15:21"), rows: [reqs.gift, ...earlier], proposals: [ilse] },
  { name: "vraag-gift-klaar", description: "Vraag Grip: the Lindeboom step ticked off at 15:42 — the question is done.",
    today: nov(2, "15:42"), rows: [reqs.giftDone, ...earlier], proposals: [ilse] },
  { name: "vraag-eerdere", description: "Vraag Grip: Eerdere vragen — afgerond, weggelegd, beantwoord, gestopt.",
    today: nov(2, "15:45"), rows: [reqs.giftDone, reqs.putAway, reqs.leefgeld, reqs.duinzorg],
    proposals: [ilse, boedelProposal(P("c1"), R("07"))] },
];

// --- The proposal screens the answer card opens ---------------------------------

const ilseProposal = JSON.parse(readFileSync(`${SHARED}proposals/${P_ILSE}.json`, "utf8")) as Record<string, unknown>;
const boedelBody = "Beste Ilse,\n\nHierbij ontvangt u mijn huurcontract en de sommatie van Kade & Partners, voor de boedelbeschrijving.\n\nMet vriendelijke groet,\n";
const proposalDetail = (id: string, o: { request: Req; attachments: { id: string; title: string; sizeBytes: number }[];
  ask?: string; body?: string; status?: string; updating?: { requestId: string; text: string; since: string } | null }) => ({
  ...ilseProposal,
  id, status: o.status ?? "pending", ask: o.ask ?? "Antwoord aan Bewindkantoor Noordkust",
  triggerAt: o.request.row.createdAt.toISOString(), createdAt: (o.request.row.answeredAt ?? o.request.row.createdAt).toISOString(),
  trigger: { type: o.request.row.parentRequestId ? "follow-up-request" : "request", id: o.request.row.id, from: null,
    subject: o.request.row.text, date: o.request.row.createdAt.toISOString(), excerpt: null },
  entrySummary: "Mail aan Bewindkantoor Noordkust: Re: Boedelbeschrijving",
  reliedOn: (o.request.detail.sources ?? []).filter((s) => s.type === "document")
    .map((s) => ({ type: s.type, id: s.id, label: s.label, why: s.why })),
  payload: { entrySummary: "Mail aan Bewindkantoor Noordkust: Re: Boedelbeschrijving",
    reply: { to: ["ilse@noordkust.example"], cc: [], subject: "Re: Boedelbeschrijving", body: o.body ?? boedelBody,
      attachmentDocumentIds: o.attachments.map((a) => a.id) }, question: null },
  attachments: o.attachments.map((a) => ({ ...a, unavailable: false })),
  attachable: o.attachments.map((a) => ({ id: a.id, title: a.title })),
  updating: o.updating ?? null,
});
const huurPdf = { id: DOC(304), title: "Huurcontract Lindehof.pdf", sizeBytes: 217088 };
const sommatiePdf = { id: DOC(106), title: "Sommatie Kade & Partners.pdf", sizeBytes: 98304 };
const loonPdf = { id: DOC(104), title: "Loonstrook.2026-10.pdf", sizeBytes: 184320 };

// --- Files ---------------------------------------------------------------------

const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const allReqs = Object.values(reqs);

function files(): Record<string, string> {
  const out: Record<string, string> = {};
  // Shared: every request's detail, the create answer, the picker's recent list.
  for (const q of allReqs) out[`_shared/requests/${q.row.id}.json`] = text(toRequestDTO(detailOf(q, allReqs)));
  out["_shared/requests.json"] = text({ requests: requestThreads(earlier.map((q) => q.row)).map(requestListItem).map(toRequestListItemDTO) });
  out["_shared/requests.post.json"] = text({ id: R("01"), status: "queued", duplicate: false });
  out[`_shared/requests/${R("05")}/retry.post.json`] = text({ id: R("01"), status: "queued", duplicate: false });
  out[`_shared/requests/${R("06")}/retry.post.json`] = text({ id: R("01"), status: "queued", duplicate: false });
  out["_shared/requests/attachable.json"] = text({ items: [
    { type: "mail", id: MAIL_BOEDEL, label: "Boedelbeschrijving invullen", meta: ["Ilse"], at: nov(2, "08:40").toISOString() },
    { type: "document", id: DOC(304), label: "Huurcontract Lindehof", meta: ["contract"], at: "2025-03-01T09:00:00.000Z" },
    { type: "party", id: "00000000-f1c5-4000-8000-600000000003", label: "Incassobureau Kade & Partners", meta: ["incasso"], at: null },
    { type: "stop", id: "00000000-f1c5-4000-8000-500000000014", label: "Stukken aanleveren bij Team Startdossier",
      meta: ["Opstart en stukken"], at: "2026-10-28T09:00:00.000Z" },
    { type: "task", id: "00000000-f1c5-4000-8000-000000000004", label: "Formulier bijzondere bijstand ondertekenen",
      meta: ["open"], at: "2026-11-03T16:00:00.000Z" },
  ] });
  out[`_shared/proposals/${P("c1")}.json`] = text(proposalDetail(P("c1"), { request: reqs.unread, attachments: [huurPdf, sommatiePdf] }));
  out[`_shared/proposals/${P("c2")}.json`] = text(proposalDetail(P("c2"), { request: reqs.followV2, attachments: [huurPdf, sommatiePdf, loonPdf],
    body: boedelBody.replace("en de sommatie van Kade & Partners", ", de sommatie van Kade & Partners en mijn loonstrook van oktober") }));
  out[`_shared/proposals/${P("c4")}.json`] = text(proposalDetail(P("c4"), { request: reqs.followNew, attachments: [loonPdf],
    ask: "Aanvulling aan Bewindkantoor Noordkust",
    body: "Beste Ilse,\n\nAls aanvulling op mijn vorige mail stuur ik u ook mijn loonstrook van oktober.\n\nMet vriendelijke groet,\n" }));
  // "Voorstel · wordt bijgewerkt": version 1 while the follow-up rewrites it.
  out[`vraag-bijgewerkt/proposals/${P("c1")}.json`] = text(proposalDetail(P("c1"), { request: reqs.rootUpdating,
    attachments: [huurPdf, sommatiePdf], updating: { requestId: R("09"), text: FOLLOW_Q, since: nov(2, "14:12").toISOString() } }));

  for (const s of states) {
    const rows = s.rows.map((q) => q.row);
    out[`${s.name}/fixture.json`] = text({ description: s.description, today: s.today.toISOString(), ...(s.extra ?? {}) });
    out[`${s.name}/requests.json`] = text({ requests: requestThreads(rows).map(requestListItem).map(toRequestListItemDTO) });
    const items = waitingOnMartin({ proposals: s.proposals, requests: rows, suggestions: [], tasks: [], currentStop: null, now: s.today });
    out[`${s.name}/inbox.json`] = text({ ...toInboxDTO(items), doneByGrip });
  }
  return out;
}

describe("the phone's Vraag Grip fixtures", () => {
  if (process.env.WRITE_FIXTURES === "1") {
    // The request files are ALL generated: stale ones from an older set go.
    rmSync(`${SHARED}requests`, { recursive: true, force: true });
    for (const d of readdirSync(FIXTURES)) if (d.startsWith("vraag-")) rmSync(`${FIXTURES}${d}`, { recursive: true, force: true });
    for (const [rel, body] of Object.entries(files())) {
      mkdirSync(dirname(`${FIXTURES}${rel}`), { recursive: true });
      writeFileSync(`${FIXTURES}${rel}`, body);
    }
  }

  it("are the server's rules over the synthetic case", () => {
    for (const [rel, body] of Object.entries(files())) {
      expect(existsSync(`${FIXTURES}${rel}`), `${rel} — regenerate with WRITE_FIXTURES=1`).toBe(true);
      expect(readFileSync(`${FIXTURES}${rel}`, "utf8"), rel).toBe(body);
    }
  });

  it("fold a question's proposal into its row, release it after Laat maar, and count a failure", () => {
    const inbox = (name: string) => JSON.parse(files()[`${name}/inbox.json`]) as
      { todo: number; items: { kind: string; id: string; subtitle: string | null }[] };
    const unread = inbox("vraag-ongelezen");
    expect(unread.items.map((i) => i.kind)).toEqual(["request", "proposal"]);
    expect(unread.items.some((i) => i.id === P("c1"))).toBe(false);
    expect(unread.todo).toBe(2);
    const putAway = inbox("vraag-laatmaar");
    expect(putAway.items.map((i) => [i.kind, i.subtitle])).toEqual([["proposal", "Uit je vraag"], ["proposal", "Bewindkantoor Noordkust"]]);
    expect(putAway.todo).toBe(unread.todo);
    expect(inbox("vraag-mislukt").items.map((i) => [i.kind, i.subtitle])[0]).toEqual(["request", "Lukte niet · Opnieuw"]);
    expect(inbox("vraag-bijgewerkt").items.map((i) => i.id)).toEqual([P_ILSE]);
    expect(inbox("vraag-wachtrij").todo).toBe(1);
  });

  it("hold every phase the frames draw, and only synthetic data", () => {
    const phases = new Set(Object.entries(files()).filter(([k]) => k.endsWith("requests.json"))
      .flatMap(([, v]) => (JSON.parse(v).requests as { phase: string }[]).map((r) => r.phase)));
    expect(phases).toEqual(new Set(["queued", "working", "updating", "todo", "done"]));
    const all = Object.values(files()).join("\n").toLowerCase();
    // The same denied words FixtureTests.fixturesHoldOnlyTheSyntheticCase checks
    // on the phone. "Gmail" the PRODUCT is a word of this feature's own copy
    // ("niet in je dossier", "zoekt live in Gmail"); a real Gmail ADDRESS is
    // what must never appear, and every address must be `.example`.
    for (const word of ["vanderpoel", "martin", "verdergroep", "verder bewind", "gmail.com", "regio 3", "abn", "almere"]) {
      expect(all).not.toMatch(new RegExp(`\\b${word.replace(".", "\\.")}\\b`));
    }
    for (const m of all.matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+)/g)) expect(m[1].endsWith(".example")).toBe(true);
  });
});
