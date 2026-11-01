import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  weekly: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const req = () => new Request("http://localhost/api/mobile/v1/weekly");

const summary = {
  week: "2026-W44", from: "2026-10-26", to: "2026-11-01",
  sent: 3, received: 7, filedByMartin: 2, filedByVerder: 3, tasksDone: 2, waiting: 4,
  topWaiting: [{ kind: "task", id: "t1", title: "Loonstrook sturen", subtitle: null,
    priority: 3, at: "2026-10-30T10:00:00.000Z", dueAt: null, verder: false }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ dashboard: { weekly: mocks.weekly } });
  mocks.weekly.mockResolvedValue(summary);
});

describe("GET /api/mobile/v1/weekly", () => {
  it("401 first", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
    expect(mocks.weekly).not.toHaveBeenCalled();
  });

  it("404 before any summary", async () => {
    mocks.weekly.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no weekly summary yet" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers the newest stored summary as is", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
  });
});
