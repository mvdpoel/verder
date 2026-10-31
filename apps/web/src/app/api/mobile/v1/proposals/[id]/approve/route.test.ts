import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  proc: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: async () => ({ proposals: { approve: mocks.proc } }),
}));

import { POST } from "./route";
import { MAX_MOBILE_JSON_BYTES } from "@/lib/mobile-json";

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
const payload = { to: ["opstart@verdergroep.nl"], cc: [], subject: "Re: x", body: "Beste,",
  attachmentDocumentIds: [], entrySummary: "Loonstrook gestuurd" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.proc.mockResolvedValue({ id: ID, status: "approved", verdict: "approved", revision: 2 });
});

describe("POST /api/mobile/v1/proposals/[id]/approve", () => {
  it("401 before the body", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const r = jsonRequest({ revision: 1, payload });
    const res = await POST(r, params);
    expect(res.status).toBe(401);
    expect(r.bodyReads()).toBe(0);
    expect(mocks.proc).not.toHaveBeenCalled();
  });

  it("passes exactly the id from the path, the revision and the payload", async () => {
    const res = await POST(jsonRequest({ revision: 1, payload, id: "forged" }), params);
    expect(res.status).toBe(200);
    expect(mocks.proc).toHaveBeenCalledWith({ id: ID, revision: 1, payload });
  });

  it("409 maps from CONFLICT", async () => {
    mocks.proc.mockRejectedValue(new TRPCError({ code: "CONFLICT", message: "proposal is approved, not pending" }));
    const res = await POST(jsonRequest({ revision: 1, payload }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "proposal is approved, not pending" });
  });

  it("400 maps from BAD_REQUEST", async () => {
    mocks.proc.mockRejectedValue(new TRPCError({ code: "BAD_REQUEST", message: "recipient not in context" }));
    expect((await POST(jsonRequest({ revision: 1, payload }), params)).status).toBe(400);
  });

  it("400 on a body that is not JSON, without calling the router", async () => {
    expect((await POST(jsonRequest("{nope"), params)).status).toBe(400);
    expect(mocks.proc).not.toHaveBeenCalled();
  });

  it("413 above 256 KB, without calling the router", async () => {
    const big = { revision: 1, payload: { ...payload, body: "x".repeat(MAX_MOBILE_JSON_BYTES) } };
    expect((await POST(jsonRequest(big), params)).status).toBe(413);
    expect(mocks.proc).not.toHaveBeenCalled();
  });
});
