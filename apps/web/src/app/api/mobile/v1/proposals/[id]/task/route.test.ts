import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  proc: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: async () => ({ proposals: { createProposedTask: mocks.proc } }),
}));

import { POST } from "./route";

/** A Request whose body reads are counted, so "before the body" is measurable. */
function jsonRequest(payload: unknown): Request & { bodyReads: () => number } {
  const real = new Request("http://localhost/api/mobile/v1/proposals/x", {
    method: "POST", headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  let reads = 0;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "bodyReads") return () => reads;
      if (prop === "body" || prop === "json" || prop === "text" || prop === "arrayBuffer") reads++;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Request & { bodyReads: () => number };
}

const ID = "0b6f1c7e-3c1a-4d7e-9f3a-2a1b3c4d5e6f";
const params = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.proc.mockResolvedValue({ taskId: "t1", created: true });
});

describe("POST /api/mobile/v1/proposals/[id]/task", () => {
  it("401 before the body", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const r = jsonRequest({});
    expect((await POST(r, params)).status).toBe(401);
    expect(r.bodyReads()).toBe(0);
    expect(mocks.proc).not.toHaveBeenCalled();
  });

  it("creates the proposed task for the id in the path", async () => {
    const res = await POST(jsonRequest({}), params);
    expect(await res.json()).toEqual({ taskId: "t1", created: true });
    expect(mocks.proc).toHaveBeenCalledWith({ id: ID });
  });

  it("409 maps from CONFLICT", async () => {
    mocks.proc.mockRejectedValue(new TRPCError({ code: "CONFLICT", message: "x" }));
    expect((await POST(jsonRequest({}), params)).status).toBe(409);
  });
});
