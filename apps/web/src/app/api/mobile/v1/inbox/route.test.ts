import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const req = () => new Request("http://localhost/api/mobile/v1/inbox");
const item = (id: string) => ({
  kind: "suggestion", id, title: `Suggestie ${id}`, subtitle: "Document", priority: 3,
  at: "2026-10-30T08:00:00.000Z", dueAt: null, verder: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ inbox: { list: mocks.list } });
  mocks.list.mockResolvedValue([item("a"), item("b")]);
});

describe("GET /api/mobile/v1/inbox", () => {
  it("401 without a session, before any router call", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mocks.serverCaller).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("inbox count equals items length", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.doneByVerder).toEqual([]);
  });

  it("is never cached", async () => {
    expect((await GET(req(), ctx)).headers.get("cache-control")).toBe("no-store");
    mocks.getSessionUserId.mockResolvedValue(null);
    expect((await GET(req(), ctx)).headers.get("cache-control")).toBe("no-store");
  });

  it("401 maps from a router UNAUTHORIZED", async () => {
    mocks.list.mockRejectedValue(new TRPCError({ code: "UNAUTHORIZED" }));
    expect((await GET(req(), ctx)).status).toBe(401);
  });
});
