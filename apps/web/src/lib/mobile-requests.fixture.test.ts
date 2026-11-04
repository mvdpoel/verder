import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requestFailureText, requestProgress } from "@grip/api/src/request-progress";
import { toRequestDTO, toRequestListItemDTO, type RequestDetailSource } from "./mobile-requests";

/**
 * The phone's Vraag Grip fixtures ARE this DTO over a synthetic case — the
 * names of docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md, all
 * invented — so the JSON the simulator draws can never drift from what the
 * routes serve. The progress line and the failure word come from the real
 * functions the router uses.
 *
 * States: queued, working (live progress), answered with a proposal (unread —
 * it waits on Martin), answered without one (opened), failed, and a follow-up
 * in the same thread. The proposal card points at the existing reply fixture
 * `proposals/…0001`, so tapping it opens a screen the simulator already has.
 *
 * Regenerate with `WRITE_FIXTURES=1 pnpm --filter web test mobile-requests.fixture`.
 */

const FIXTURES = fileURLToPath(new URL("../../../ios/Grip/FixtureData/_shared/", import.meta.url));
const R = (n: number) => `00000000-f1c5-4000-8000-a0000000000${n}`;
const C = (n: number) => `6f0b7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5${n}`;
const DOC = (n: number) => `00000000-f1c5-4000-8000-200000000${n}`;
const MAIL_ILSE = "00000000-f1c5-4000-8000-400000000201";
const PROPOSAL_ILSE = "00000000-f1c5-4000-8000-000000000001";
const PARTY_STROOMNET = "00000000-f1c5-4000-8000-600000000003";
const TX = (n: number) => `00000000-f1c5-4000-8000-70000000000${n}`;
const at = (s: string) => new Date(`2026-11-${s}:00.000Z`);
const call = (tool: string) => ({ tool });

const base = (o: Partial<RequestDetailSource> & Pick<RequestDetailSource, "id" | "clientId" | "text" | "status" | "createdAt">): RequestDetailSource => ({
  parentRequestId: null, claimedAt: null, answeredAt: null, openedAt: null, unread: false,
  progressLine: null, failure: null, about: null, answer: null, sources: [], martinSteps: [], proposal: null,
  progress: null, thread: [], followUps: [], ...o,
});

const workingLog = [call("search"), call("get_document"), call("get_document"), call("list_transactions")];
const progress = requestProgress(workingLog);

const STROOMNET_ANSWER = [
  "Ja, er loopt nog een incasso. Stroomnet Energie schreef op 1 oktober en op 3 november elk € 42,50 af van je rekening.",
  "",
  "De vordering van Kade & Partners namens Stroomnet staat los daarvan: die gaat over de oude jaarafrekening. Je hoeft voor de lopende incasso dus niets aan Kade te sturen.",
].join("\n");

const requests: RequestDetailSource[] = [
  base({ id: R(6), clientId: C(6), text: "En moet ik die incasso stoppen nu Noordkust mijn rekening beheert?",
    status: "answered", parentRequestId: R(4), createdAt: at("04T10:05"), claimedAt: at("04T10:06"),
    answeredAt: at("04T10:08"), unread: true,
    answer: "Nee, laat hem lopen. De stroom is een vaste last die Noordkust vanaf de beheerrekening betaalt. Vraag Ilse wel of ze de incasso op de beheerrekening overneemt, dan gaat er niets mis bij de overstap.",
    sources: [{ type: "transaction", id: TX(2), why: "De incasso van 3 november.", label: "Stroomnet Energie · -€ 42,50" }],
    martinSteps: ["Vraag Ilse of Noordkust de incasso van Stroomnet overneemt"],
    thread: [{ id: R(4), text: "Loopt er nog een incasso van Stroomnet Energie?", status: "answered",
      createdAt: at("04T09:40"), answer: STROOMNET_ANSWER }] }),
  base({ id: R(1), clientId: C(1), text: "Kun je uitzoeken wat Gemeente Westerlaan nog nodig heeft voor de bijzondere bijstand?",
    status: "queued", createdAt: at("04T10:02"),
    about: { type: "document", id: DOC(307), label: "Brief Gemeente Westerlaan 30 okt" },
    progress: { ...requestProgress([]), gmail: 0 } }),
  base({ id: R(2), clientId: C(2), text: "Welke loonstroken heeft Team Startdossier al van me gekregen?",
    status: "working", createdAt: at("04T09:58"), claimedAt: at("04T09:59"),
    progressLine: progress.line, progress: { calls: progress.calls, documents: progress.documents, mails: progress.mails,
      gmail: progress.gmail, line: progress.line } }),
  base({ id: R(3), clientId: C(3), text: "Ilse vraagt om mijn loonstrook van oktober. Kun je een antwoord klaarzetten?",
    status: "answered", createdAt: at("04T09:50"), claimedAt: at("04T09:51"), answeredAt: at("04T09:54"), unread: true,
    about: { type: "mail", id: MAIL_ILSE, label: "Loonstrook oktober" },
    answer: "Ik heb de loonstrook van oktober gevonden en een antwoord aan Ilse klaargezet, met de loonstrook als bijlage. Lees het even na; versturen doe jij.",
    sources: [
      { type: "mail", id: MAIL_ILSE, why: "Ilse vraagt om de loonstrook van oktober.", label: "Loonstrook oktober" },
      { type: "document", id: DOC(104), why: "De gevraagde loonstrook.", label: "Loonstrook 2026-10" },
    ],
    proposal: { id: PROPOSAL_ILSE, status: "pending", kind: "reply", to: ["ilse@noordkust.example"],
      subject: "Re: Loonstrook oktober", attachmentCount: 1 } }),
  base({ id: R(4), clientId: C(4), text: "Loopt er nog een incasso van Stroomnet Energie?",
    status: "answered", createdAt: at("04T09:40"), claimedAt: at("04T09:41"), answeredAt: at("04T09:44"),
    openedAt: at("04T09:50"), answer: STROOMNET_ANSWER,
    sources: [
      { type: "transaction", id: TX(1), why: "De incasso van 1 oktober.", label: "Stroomnet Energie · -€ 42,50" },
      { type: "transaction", id: TX(2), why: "De incasso van 3 november.", label: "Stroomnet Energie · -€ 42,50" },
      { type: "party", id: PARTY_STROOMNET, why: "De schuldeiser achter Kade & Partners.", label: "Stroomnet Energie" },
    ],
    followUps: [{ id: R(6), text: "En moet ik die incasso stoppen nu Noordkust mijn rekening beheert?",
      status: "answered", createdAt: at("04T10:05") }] }),
  base({ id: R(5), clientId: C(5), text: "Zoek de polis van Duinzorg en kijk of de premie al is aangepast.",
    status: "failed", createdAt: at("03T20:10"), claimedAt: at("03T20:11"),
    failure: requestFailureText("runner: claude-exit-124") }),
];

const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const files = (): Record<string, string> => {
  const out: Record<string, string> = {
    "requests.json": text({ requests: requests.map((r) => toRequestListItemDTO({ ...r, proposal: r.proposal
      ? { id: r.proposal.id, status: r.proposal.status } : null })) }),
    "requests.post.json": text({ id: R(1), status: "queued", duplicate: false }),
    [`requests/${R(2)}/cancel.post.json`]: text({ id: R(2), status: "cancelled" }),
    [`requests/${R(3)}/opened.post.json`]: text({ id: R(3), openedAt: "2026-11-04T10:12:00.000Z" }),
  };
  for (const r of requests) out[`requests/${r.id}.json`] = text(toRequestDTO(r));
  return out;
};

describe("the phone's Vraag Grip fixtures", () => {
  if (process.env.WRITE_FIXTURES === "1") {
    for (const [rel, body] of Object.entries(files())) {
      mkdirSync(dirname(`${FIXTURES}${rel}`), { recursive: true });
      writeFileSync(`${FIXTURES}${rel}`, body);
    }
  }

  it("are the DTO over the synthetic case", () => {
    for (const [rel, body] of Object.entries(files())) {
      expect(existsSync(`${FIXTURES}${rel}`), `${rel} — regenerate with WRITE_FIXTURES=1`).toBe(true);
      expect(readFileSync(`${FIXTURES}${rel}`, "utf8"), rel).toBe(body);
    }
  });

  it("hold every state the phone draws, and only synthetic data", () => {
    const list = JSON.parse(files()["requests.json"]).requests as { status: string; unread: boolean; parentRequestId: string | null }[];
    expect(new Set(list.map((r) => r.status))).toEqual(new Set(["queued", "working", "answered", "failed"]));
    expect(list.some((r) => r.unread)).toBe(true);
    expect(list.some((r) => r.parentRequestId !== null)).toBe(true);
    const all = Object.values(files()).join("\n").toLowerCase();
    // The same denied words FixtureTests.fixturesHoldOnlyTheSyntheticCase checks on the phone.
    for (const word of ["vanderpoel", "martin", "verdergroep", "verder bewind", "gmail", "regio 3", "abn", "almere"]) {
      expect(all).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
    for (const m of all.matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+)/g)) expect(m[1].endsWith(".example")).toBe(true);
  });
});
