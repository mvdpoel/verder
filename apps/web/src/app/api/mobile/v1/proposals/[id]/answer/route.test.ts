import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  proc: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: async () => ({ proposals: { answer: mocks.proc } }),
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
  mocks.proc.mockResolvedValue({ id: ID, status: "sent", revision: 2, taskId: null });
});

describe("POST /api/mobile/v1/proposals/[id]/answer", () => {
  it("401 before the body", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const r = jsonRequest({ revision: 1, option: 0 });
    expect((await POST(r, params)).status).toBe(401);
    expect(r.bodyReads()).toBe(0);
    expect(mocks.proc).not.toHaveBeenCalled();
  });

  it("passes an option, or free text, and nothing else", async () => {
    await POST(jsonRequest({ revision: 1, option: 2, status: "done", taskId: "forged" }), params);
    expect(mocks.proc).toHaveBeenLastCalledWith({ id: ID, revision: 1, option: 2 });
    await POST(jsonRequest({ revision: 1, freeText: "Ik bel zelf" }), params);
    expect(mocks.proc).toHaveBeenLastCalledWith({ id: ID, revision: 1, freeText: "Ik bel zelf" });
  });

  it("409 maps from CONFLICT", async () => {
    mocks.proc.mockRejectedValue(new TRPCError({ code: "CONFLICT", message: "stale revision" }));
    expect((await POST(jsonRequest({ revision: 1, option: 0 }), params)).status).toBe(409);
  });

  it("400 maps from BAD_REQUEST (an option whose target is no longer valid)", async () => {
    mocks.proc.mockRejectedValue(new TRPCError({ code: "BAD_REQUEST", message: "the task cannot move done → done" }));
    const res = await POST(jsonRequest({ revision: 1, option: 0 }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "the task cannot move done → done" });
  });
});
