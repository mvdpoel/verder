import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTrackMap, filterDebtEpisodes, type StopRow, type TrackRow,
} from "@verder/api/src/track-map";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  map: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const ROOT = "00000000-0000-4000-8000-0000000000a0";
const DEBT = "00000000-0000-4000-8000-0000000000a2";
const base = { kind: "other", expectedAt: null, stage: null, entryId: null, taskId: null,
  documentId: null, note: null } as const;
const tracks: TrackRow[] = [
  { id: ROOT, title: "Bewindvoering", status: "open", parentTrackId: null,
    branchesAtStopId: null, mergesAtStopId: null, note: null },
  { id: DEBT, title: "Vordering Kade & Partners", status: "open", parentTrackId: ROOT,
    branchesAtStopId: "s-trigger", mergesAtStopId: null, note: null },
];
const stops: StopRow[] = [
  { ...base, id: "s-start", trackId: ROOT, orderIndex: 0, title: "Aanmelding", state: "done",
    happenedAt: new Date("2026-05-12T10:00:00.000Z") },
  { ...base, id: "s-trigger", trackId: ROOT, orderIndex: 1, title: "Sommatie", state: "done",
    happenedAt: new Date("2026-10-14T10:00:00.000Z") },
  { ...base, id: "s-debt", trackId: DEBT, orderIndex: 0, title: "Verwerkt als vordering",
    state: "done", happenedAt: new Date("2026-10-15T10:00:00.000Z") },
];

const ctx = { params: Promise.resolve({}) };
const req = (qs = "") => new Request(`http://localhost/api/mobile/v1/case-map${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ tracks: { map: mocks.map } });
  // The router's own two steps, for real: filter the INPUT, then build.
  mocks.map.mockImplementation(async (input?: { hideDebtEpisodes?: boolean }) => {
    const filtered = filterDebtEpisodes({ tracks, stops }, input?.hideDebtEpisodes ?? false);
    const map = buildTrackMap(filtered);
    return {
      map,
      evidence: Object.fromEntries(map.stops.map((s) =>
        [s.id, { entry: null, task: null, documents: [], email: null }])),
      hiddenDebtTrackCount: filtered.hiddenTrackCount,
    };
  });
});

describe("GET /api/mobile/v1/case-map", () => {
  it("401 without a session, before any router call", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mocks.serverCaller).not.toHaveBeenCalled();
    expect(mocks.map).not.toHaveBeenCalled();
  });

  it("answers the whole map by default, uncached", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.map).toHaveBeenCalledWith({ hideDebtEpisodes: false });
    const body = await res.json();
    expect(body.debtEpisodesHidden).toBe(false);
    expect(body.stops.map((s: { id: string }) => s.id).sort()).toEqual(["s-debt", "s-start", "s-trigger"]);
  });

  it("?schuldeisers=verborgen hides the debt spoor and its trigger", async () => {
    const body = await (await GET(req("?schuldeisers=verborgen"), ctx)).json();
    expect(mocks.map).toHaveBeenCalledWith({ hideDebtEpisodes: true });
    expect(body.stops.map((s: { id: string }) => s.id)).toEqual(["s-start"]);
    expect(body.tracks.map((t: { id: string }) => t.id)).toEqual([ROOT]);
    expect(body.hiddenDebtTrackCount).toBe(1);
    expect(body.debtEpisodesHidden).toBe(true);
  });

  it("any other value is the default view, the web's rule", async () => {
    await GET(req("?schuldeisers=ja"), ctx);
    expect(mocks.map).toHaveBeenCalledWith({ hideDebtEpisodes: false });
  });

  it("is the hand-shaped DTO, never the router's output", async () => {
    const body = await (await GET(req(), ctx)).json();
    expect(body).not.toHaveProperty("map");
    expect(body).not.toHaveProperty("evidence");
    expect(body.stops[0]).not.toHaveProperty("orderIndex");
    expect(body.stops[0]).toHaveProperty("evidence");
  });
});
