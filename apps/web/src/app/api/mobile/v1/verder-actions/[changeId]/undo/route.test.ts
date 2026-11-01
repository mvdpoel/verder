import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  undo: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { POST } from "./route";

const ID = "5d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
const ctx = { params: Promise.resolve({ changeId: ID }) };

function jsonRequest(payload: unknown): Request & { bodyReads: () => number } {
  const real = new Request(`http://localhost/api/mobile/v1/verder-actions/${ID}/undo`, {
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
  mocks.serverCaller.mockResolvedValue({ verderActions: { undo: mocks.undo } });
  mocks.undo.mockResolvedValue({ documentId: "d1", undoChangeId: "u1" });
});

describe("POST /api/mobile/v1/verder-actions/[changeId]/undo", () => {
  it("401 first: before the body and before any router call", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const r = jsonRequest({});
    const res = await POST(r, ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(r.bodyReads()).toBe(0);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
  });

  it("undoes the change named by the path", async () => {
    const res = await POST(jsonRequest(""), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, documentId: "d1" });
    expect(mocks.undo).toHaveBeenCalledWith({ changeId: ID });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses any body field", async () => {
    const res = await POST(jsonRequest({ changeId: "forged" }), ctx);
    expect(res.status).toBe(400);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("a change made since answers 409 with the reason", async () => {
    mocks.undo.mockRejectedValue(new TRPCError({ code: "CONFLICT", message: "al aangepast" }));
    const res = await POST(jsonRequest({}), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "al aangepast" });
  });

  it("an auto-name answers 400", async () => {
    mocks.undo.mockRejectedValue(
      new TRPCError({ code: "BAD_REQUEST", message: "naam staat ook op de NAS" }));
    expect((await POST(jsonRequest({}), ctx)).status).toBe(400);
  });
});
