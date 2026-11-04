import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { briefSummary, buildTalkingPoints, type BriefRow, type TalkingPointsInput } from "@grip/api/src/talking-points";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  talkingPoints: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const PARTY = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-11-03T10:00:00.000Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 24 * 3600 * 1000);
const call = (id = PARTY) => GET(
  new Request(`http://localhost/api/mobile/v1/parties/${id}/talking-points`),
  { params: Promise.resolve({ id }) });

// The mock runs the REAL pure halves (buildTalkingPoints, briefSummary), so the
// route is tested against what the loader would hand it, not a hand-made answer.
const dossier: TalkingPointsInput = {
  now: NOW, lastRequestAt: ago(5),
  tasks: [{ id: "t1", title: "Beschikking toesturen", status: "waiting", statusAt: ago(2), dueAt: null, createdAt: ago(9) }],
  sent: [{ id: "p1", type: "proposal", subject: "Loonstrook oktober", sentAt: ago(4), repliedAt: null }],
  debts: [{ id: "d1", creditorName: "Stroomnet Energie", claimedCents: null, reference: null }],
  documents: [
    { id: "doc-ok", title: "Huurcontract.pdf", at: ago(1), how: "sent", status: "filed", purged: false },
    { id: "doc-gone", title: "image.png", at: ago(1), how: "filed", status: "discarded", purged: false },
  ],
  openStops: [],
};
const brief = (status: string): BriefRow => ({
  status, summary: "Ilse vroeg op 29 okt om je loonstrook; die is nog onderweg.", model: "claude-cli 2.1.0",
  promptVersion: "brief-v1", generatedAt: ago(1), sourceRefs: [{ type: "mail", id: "r1" }],
});
const loaded = (status: string | null) => ({
  party: { id: PARTY, name: "Bewindkantoor Noordkust", phone: "06 0000 0002",
    email: "ilse@noordkust.example", notes: "privé" },
  ...buildTalkingPoints(dossier),
  summary: briefSummary(status === null ? null : brief(status)),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ parties: { talkingPoints: mocks.talkingPoints } });
  mocks.talkingPoints.mockResolvedValue(loaded("ready"));
});

describe("GET /api/mobile/v1/parties/[id]/talking-points", () => {
  it("401 first, as JSON, before any router call", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mocks.serverCaller).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers the hand-shaped DTO: tell, ask, and the AI line labelled as AI", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.talkingPoints).toHaveBeenCalledWith({ id: PARTY });
    const body = await res.json();
    // The phone number is the call sheet's "Bel"; the email and the note never travel.
    expect(body.party).toEqual({ id: PARTY, name: "Bewindkantoor Noordkust", phone: "06 0000 0002" });
    expect(body.ask).toEqual([
      { id: "ask:task:t1", text: "Vraag naar: Beschikking toesturen",
        source: { type: "task", id: "t1", link: "grip://task/t1" } },
      { id: "ask:proposal:p1", text: "Nog geen antwoord op je mail van 30 okt: Loonstrook oktober",
        source: { type: "proposal", id: "p1", link: "grip://proposal/p1" } },
      { id: "ask:debt:d1", text: "Vraag het gevorderde bedrag: Stroomnet Energie",
        source: { type: "debt", id: "d1", link: "grip://dossier" } },
    ]);
    expect(body.tell).toEqual([
      { id: "tell:document:doc-ok", text: "Opgestuurd op 2 nov: Huurcontract.pdf",
        source: { type: "document", id: "doc-ok", link: "grip://document/doc-ok" } },
    ]);
    expect(body.summary).toEqual({
      text: "Ilse vroeg op 29 okt om je loonstrook; die is nog onderweg.", model: "claude-cli 2.1.0",
      promptVersion: "brief-v1", generatedAt: ago(1).toISOString(), sourceRefs: [{ type: "mail", id: "r1" }],
      ai: true, label: "Samenvatting door AI",
    });
    // Nothing the router knows about the party beyond its name reaches the phone.
    expect(JSON.stringify(body)).not.toContain("noordkust.example");
    expect(JSON.stringify(body)).not.toContain("privé");
  });

  it("a discarded document never appears", async () => {
    const body = await (await call()).json();
    expect(JSON.stringify(body)).not.toContain("doc-gone");
    expect(JSON.stringify(body)).not.toContain("image.png");
  });

  it("the summary is null until the brief is ready", async () => {
    for (const status of [null, "pending", "drafting", "failed"]) {
      mocks.talkingPoints.mockResolvedValue(loaded(status));
      const body = await (await call()).json();
      expect(body.summary, String(status)).toBeNull();
      expect(body.ask).toHaveLength(3);
    }
  });

  it("400 for an id that is not a uuid, without a router call", async () => {
    const res = await call("not-a-uuid");
    expect(res.status).toBe(400);
    expect(mocks.talkingPoints).not.toHaveBeenCalled();
  });

  it("404 for an unknown party", async () => {
    mocks.talkingPoints.mockRejectedValue(new TRPCError({ code: "NOT_FOUND", message: "Party not found" }));
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
