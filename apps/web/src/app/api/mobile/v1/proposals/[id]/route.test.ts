import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  proc: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: async () => ({ proposals: { get: mocks.proc } }),
}));

import { GET } from "./route";

const ID = "0b6f1c7e-3c1a-4d7e-9f3a-2a1b3c4d5e6f";
const params = { params: Promise.resolve({ id: ID }) };
const req = () => new Request(`http://localhost/api/mobile/v1/proposals/${ID}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.proc.mockResolvedValue({ id: ID, revision: 1 });
});

describe("GET /api/mobile/v1/proposals/[id]", () => {
  it("401 before calling the router", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), params);
    expect(res.status).toBe(401);
    expect(mocks.proc).not.toHaveBeenCalled();
  });

  it("passes the id from the path", async () => {
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(mocks.proc).toHaveBeenCalledWith({ id: ID });
  });

  it("404 maps from NOT_FOUND", async () => {
    mocks.proc.mockRejectedValue(new TRPCError({ code: "NOT_FOUND" }));
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("409 maps from CONFLICT", async () => {
    mocks.proc.mockRejectedValue(new TRPCError({ code: "CONFLICT", message: "x" }));
    expect((await GET(req(), params)).status).toBe(409);
  });

  it("400 maps from BAD_REQUEST (a malformed id)", async () => {
    mocks.proc.mockRejectedValue(new TRPCError({ code: "BAD_REQUEST", message: "invalid uuid" }));
    expect((await GET(req(), params)).status).toBe(400);
  });
});
