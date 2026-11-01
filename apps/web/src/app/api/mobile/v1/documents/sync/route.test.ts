import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  delta: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const req = (q = "?cursor=0") => new Request(`http://localhost/api/mobile/v1/documents/sync${q}`);

const DELTA = {
  cursor: 812, more: true,
  upserts: [{ id: "d-1", title: "Beschikking", docType: "beschikking", status: "filed",
    receivedAt: "2026-07-14T08:00:00.000Z", mime: "application/pdf", sizeBytes: 1234,
    sha256: "a".repeat(64), hasText: true }],
  tombstones: [{ id: "d-2", reason: "purged" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ dossierSync: { delta: mocks.delta } });
  mocks.delta.mockResolvedValue(DELTA);
});

describe("GET /api/mobile/v1/documents/sync", () => {
  it("401 first", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mocks.serverCaller).not.toHaveBeenCalled();
  });

  it("passes cursor and limit and answers the delta, uncached", async () => {
    const res = await GET(req("?cursor=700&limit=25"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.delta).toHaveBeenCalledWith({ cursor: 700, limit: 25 });
    expect(await res.json()).toEqual(DELTA);
  });

  it("no cursor starts from the beginning at the full page", async () => {
    await GET(req(""), ctx);
    expect(mocks.delta).toHaveBeenCalledWith({ cursor: 0, limit: 50 });
  });

  it.each(["?cursor=-1", "?cursor=abc", "?cursor=1.5", "?cursor=0&limit=51", "?cursor=0&limit=0"])(
    "400 on %s, before the router", async (q) => {
      const res = await GET(req(q), ctx);
      expect(res.status).toBe(400);
      expect(mocks.delta).not.toHaveBeenCalled();
    });
});
