import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  reject: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { POST } from "./route";

const ID = "0b6f1c7e-3c1a-4d7e-9f3a-2a1b3c4d5e6f";
const ctx = { params: Promise.resolve({ id: ID }) };

function jsonRequest(payload: unknown): Request & { bodyReads: () => number } {
  const real = new Request(`http://localhost/api/mobile/v1/suggestions/${ID}/reject`, {
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ suggestions: { reject: mocks.reject } });
  mocks.reject.mockResolvedValue(undefined);
});

describe("POST /api/mobile/v1/suggestions/[id]/reject", () => {
  it("401 before reading the body", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const r = jsonRequest({ reason: "spam" });
    expect((await POST(r, ctx)).status).toBe(401);
    expect(r.bodyReads()).toBe(0);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
  });

  it("passes the id from the path and the optional reason", async () => {
    const res = await POST(jsonRequest({ reason: "Geen dossierpost" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.reject).toHaveBeenLastCalledWith({ id: ID, reason: "Geen dossierpost" });
    await POST(jsonRequest(""), ctx);
    expect(mocks.reject).toHaveBeenLastCalledWith({ id: ID, reason: undefined });
  });

  it("refuses any other field", async () => {
    const res = await POST(jsonRequest({ reason: "x", id: "forged" }), ctx);
    expect(res.status).toBe(400);
    expect(mocks.reject).not.toHaveBeenCalled();
  });

  it("a verdict already given is 409", async () => {
    mocks.reject.mockRejectedValue(
      new TRPCError({ code: "CONFLICT", message: "Suggestion not open for review" }));
    expect((await POST(jsonRequest({}), ctx)).status).toBe(409);
  });
});
