import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  recent: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const req = (q = "?recent=1") => new Request(`http://localhost/api/mobile/v1/parties${q}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ parties: { recent: mocks.recent } });
  mocks.recent.mockResolvedValue([
    { id: "p-2", kind: "organization", name: "Verder", organization: null,
      email: "x@verdergroep.nl", lastContactAt: new Date("2026-10-20T09:00:00.000Z") },
    { id: "p-1", kind: "organization", name: "CAK", organization: null,
      email: null, lastContactAt: null },
  ]);
});

describe("GET /api/mobile/v1/parties", () => {
  it("401 first, before any router call", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
  });

  it("?recent=1 keeps the most-recent-contact order and answers DTOs only", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "p-2", kind: "organization", name: "Verder", organization: null,
        lastContactAt: "2026-10-20T09:00:00.000Z" },
      { id: "p-1", kind: "organization", name: "CAK", organization: null, lastContactAt: null },
    ]);
  });

  it("without recent the same parties come by name", async () => {
    const res = await GET(req(""), ctx);
    expect((await res.json()).map((p: { id: string }) => p.id)).toEqual(["p-1", "p-2"]);
  });

  it("400 on any other recent value", async () => {
    const res = await GET(req("?recent=yes"), ctx);
    expect(res.status).toBe(400);
  });
});
