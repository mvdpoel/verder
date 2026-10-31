import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  list: vi.fn(),
  validNext: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const req = (q = "?filter=open") => new Request(`http://localhost/api/mobile/v1/tasks${q}`);

const NEXT: Record<string, string[]> = {
  open: ["in-progress", "waiting", "done", "dropped"],
  "in-progress": ["waiting", "done", "dropped"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ tasks: { list: mocks.list, validNext: mocks.validNext } });
  mocks.validNext.mockImplementation(async ({ from }: { from: string }) => NEXT[from] ?? []);
  mocks.list.mockResolvedValue([
    { id: "t-1", title: "Loonstroken sturen", details: "juni t/m sept",
      dueAt: new Date("2026-11-02T23:00:00.000Z"), status: "open",
      effectiveStatus: "in-progress", assigneeName: "Martin",
      createdAt: new Date("2026-10-01T00:00:00.000Z"), createdBy: "user-1" },
    { id: "t-2", title: "Polis opzoeken", details: null, dueAt: null, status: "open",
      effectiveStatus: "open", assigneeName: null,
      createdAt: new Date("2026-10-02T00:00:00.000Z"), createdBy: "user-1" },
  ]);
});

describe("GET /api/mobile/v1/tasks", () => {
  it("401 without a session, before any router call", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("passes the filter and answers TaskDTOs with their valid next statuses", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ filter: "open" });
    expect(await res.json()).toEqual([
      { id: "t-1", title: "Loonstroken sturen", details: "juni t/m sept",
        dueAt: "2026-11-02T23:00:00.000Z", status: "in-progress", assigneeName: "Martin",
        validNext: NEXT["in-progress"] },
      { id: "t-2", title: "Polis opzoeken", details: null, dueAt: null, status: "open",
        assigneeName: null, validNext: NEXT.open },
    ]);
  });

  it("asks validNext once per distinct status", async () => {
    mocks.list.mockResolvedValue([
      { id: "a", title: "A", details: null, dueAt: null, effectiveStatus: "open", assigneeName: null },
      { id: "b", title: "B", details: null, dueAt: null, effectiveStatus: "open", assigneeName: null },
    ]);
    await GET(req(), ctx);
    expect(mocks.validNext).toHaveBeenCalledTimes(1);
    expect(mocks.validNext).toHaveBeenCalledWith({ from: "open" });
  });

  it("no filter lists every task", async () => {
    await GET(req(""), ctx);
    expect(mocks.list).toHaveBeenCalledWith({ filter: undefined });
  });

  it("400 on an unknown filter, before the router", async () => {
    const res = await GET(req("?filter=alles"), ctx);
    expect(res.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
