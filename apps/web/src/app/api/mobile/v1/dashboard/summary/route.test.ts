import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  map: vi.fn(),
  stats: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const req = () => new Request("http://localhost/api/mobile/v1/dashboard/summary");
const stats = { openCount: 3, overdueCount: 1, waitingOnOthersCount: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({
    tracks: { map: mocks.map }, tasks: { stats: mocks.stats }, inbox: { count: mocks.count },
  });
  mocks.stats.mockResolvedValue(stats);
  mocks.count.mockResolvedValue(5);
  mocks.map.mockResolvedValue({
    map: {
      currentStopId: "stop-1",
      stops: [{ id: "stop-1", trackId: "tr-1", title: "Stukken aanleveren",
        note: null, happenedAt: new Date("2026-08-28T10:00:00.000Z"), state: "open" }],
      tracks: [{ id: "tr-1", title: "Opstartstukken" }],
    },
    evidence: {}, hiddenDebtTrackCount: 0,
  });
});

describe("GET /api/mobile/v1/dashboard/summary", () => {
  it("401 without a session, before any router call", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
    expect(mocks.map).not.toHaveBeenCalled();
  });

  it("answers the headline, the waiting count and the task tiles", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      headline: { stopTitle: "Stukken aanleveren", trackTitle: "Opstartstukken",
        happenedAt: "2026-08-28T10:00:00.000Z", note: null },
      waitingCount: 5,
      tasks: stats,
    });
  });

  it("summary headline is null when no stop is open", async () => {
    mocks.map.mockResolvedValue({
      map: { currentStopId: null, stops: [], tracks: [] }, evidence: {}, hiddenDebtTrackCount: 0,
    });
    const body = await (await GET(req(), ctx)).json();
    expect(body.headline).toBeNull();
    expect(body.waitingCount).toBe(5);
  });
});
