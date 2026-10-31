import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  proc: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: async () => ({ proposals: { list: mocks.proc } }),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.proc.mockResolvedValue([{ id: "p1", status: "pending" }]);
});

describe("GET /api/mobile/v1/proposals", () => {
  it("401 before calling the router", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mocks.proc).not.toHaveBeenCalled();
  });

  it("returns the list", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proposals: [{ id: "p1", status: "pending" }] });
  });

  it("409 maps from CONFLICT", async () => {
    mocks.proc.mockRejectedValue(new TRPCError({ code: "CONFLICT", message: "busy" }));
    const res = await GET();
    expect(res.status).toBe(409);
  });
});
