import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { briefSummary, buildTalkingPoints, type TalkingPointsInput } from "@verder/api/src/talking-points";
import { toTalkingPointsDTO } from "./mobile-talking-points";

/**
 * The phone's talking-points fixtures ARE this DTO over the synthetic call —
 * section "A call (talking points)" of
 * docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md, all invented —
 * built by the REAL `buildTalkingPoints` + `briefSummary`, so the JSON the
 * simulator draws can never drift from what the route serves.
 *
 * Regenerate with `WRITE_FIXTURES=1 pnpm --filter web test mobile-talking-points.fixture`.
 */

const FIXTURES = fileURLToPath(new URL("../../../ios/Verder/FixtureData/_shared/parties/", import.meta.url));
const NOORDKUST = "00000000-f1c5-4000-8000-600000000002";
const KADE = "00000000-f1c5-4000-8000-600000000003";
const file = (party: string) => `${FIXTURES}${party}/talking-points.json`;

// The case's "today": Sun 1 nov 2026, 09:41 Amsterdam.
const NOW = new Date("2026-11-01T08:41:00.000Z");
const MAIL = (n: number) => `00000000-f1c5-4000-8000-9000000000${String(n).padStart(2, "0")}`;
const DEBT_STROOMNET = "00000000-f1c5-4000-8000-a00000000001";
const DOC_LOON_OKT = "00000000-f1c5-4000-8000-200000000104";
const DOC_LOON_SEP = "00000000-f1c5-4000-8000-200000000105";
const TASK_REACTIE_KADE = "00000000-f1c5-4000-8000-300000000016";
const STOP_STUKKEN = "00000000-f1c5-4000-8000-500000000006";

const noordkust: TalkingPointsInput = {
  now: NOW,
  // Team Startdossier asked for the stukken on 28 okt (MAIL 1).
  lastRequestAt: new Date("2026-10-28T09:00:00.000Z"),
  tasks: [],
  sent: [
    // Unanswered for twelve days: a chase.
    { id: MAIL(2), type: "mail", subject: "Vraag over leefgeld november",
      sentAt: new Date("2026-10-20T10:00:00.000Z"), repliedAt: null },
    // Two days old minus a few hours: still "on its way".
    { id: MAIL(3), type: "mail", subject: "Loonstroken september en oktober",
      sentAt: new Date("2026-10-30T10:00:00.000Z"), repliedAt: null },
  ],
  debts: [],
  documents: [
    { id: DOC_LOON_OKT, title: "Loonstrook 2026-10", at: new Date("2026-10-30T10:00:00.000Z"),
      how: "sent", status: "filed", purged: false },
    { id: DOC_LOON_SEP, title: "Loonstrook 2026-09", at: new Date("2026-10-30T10:00:00.000Z"),
      how: "sent", status: "filed", purged: false },
  ],
  openStops: [{ id: STOP_STUKKEN, title: "Stukken aanleveren bij Team Startdossier", at: null }],
};

const kade: TalkingPointsInput = {
  now: NOW,
  lastRequestAt: new Date("2026-10-14T09:00:00.000Z"),
  tasks: [{ id: TASK_REACTIE_KADE, title: "Reactie Kade & Partners op de sommatie", status: "waiting",
    statusAt: new Date("2026-10-15T09:00:00.000Z"), dueAt: null, createdAt: new Date("2026-10-14T09:30:00.000Z") }],
  sent: [],
  debts: [{ id: DEBT_STROOMNET, creditorName: "Stroomnet Energie", claimedCents: null, reference: "KP-2026-0114" }],
  documents: [],
  openStops: [],
};

const dto = (party: { id: string; name: string; phone: string | null }, input: TalkingPointsInput, brief: Parameters<typeof briefSummary>[0]) =>
  toTalkingPointsDTO({ party, ...buildTalkingPoints(input), summary: briefSummary(brief) });

const noordkustDTO = () => dto({ id: NOORDKUST, name: "Bewindkantoor Noordkust", phone: "06 0000 0002" }, noordkust, {
  status: "ready",
  summary: "Team Startdossier vroeg op 28 okt om je loonstroken; die heb je op 30 okt gestuurd, een antwoord is er nog niet.",
  model: "claude-cli 2.1.0 (Claude Code)", promptVersion: "brief-v1",
  generatedAt: new Date("2026-10-30T10:05:00.000Z"),
  sourceRefs: [{ type: "mail", id: MAIL(1) }, { type: "mail", id: MAIL(3) }],
});
// Kade & Partners' brief is still pending: the screen shows the points and no AI line.
const kadeDTO = () => dto({ id: KADE, name: "Incassobureau Kade & Partners", phone: null }, kade, {
  status: "pending", summary: null, model: null, promptVersion: null, generatedAt: null, sourceRefs: [],
});

const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

describe("the phone's talking-points fixtures", () => {
  if (process.env.WRITE_FIXTURES === "1") {
    for (const [party, f] of [[NOORDKUST, noordkustDTO], [KADE, kadeDTO]] as const) {
      mkdirSync(dirname(file(party)), { recursive: true });
      writeFileSync(file(party), text(f()));
    }
  }

  it("are the DTO over the synthetic call", () => {
    expect(readFileSync(file(NOORDKUST), "utf8")).toBe(text(noordkustDTO()));
    expect(readFileSync(file(KADE), "utf8")).toBe(text(kadeDTO()));
  });

  it("say what the data doc says", () => {
    const n = noordkustDTO();
    expect(n.ask.map((p) => p.text)).toEqual([
      "Nog geen antwoord op je mail van 20 okt: Vraag over leefgeld november",
      "Bespreek: Stukken aanleveren bij Team Startdossier",
    ]);
    expect(n.tell.map((p) => p.text)).toEqual([
      "Opgestuurd op 30 okt: Loonstrook 2026-10",
      "Opgestuurd op 30 okt: Loonstrook 2026-09",
      "Gemaild op 30 okt: Loonstroken september en oktober",
    ]);
    expect(n.summary?.label).toBe("Samenvatting door AI");
    // An invented number in the unassigned 06-0 block: the call sheet's "Bel".
    expect(n.party.phone).toBe("06 0000 0002");
    const k = kadeDTO();
    expect(k.ask.map((p) => p.text)).toEqual([
      "Vraag naar: Reactie Kade & Partners op de sommatie",
      "Vraag het gevorderde bedrag: Stroomnet Energie (KP-2026-0114)",
    ]);
    expect(k.tell).toEqual([]);
    expect(k.summary).toBeNull();
    // No number recorded: the sheet says so instead of offering a dead "Bel".
    expect(k.party.phone).toBeNull();
  });
});
