import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { POST } from "./route";

const ID = "0b6f1c7e-3c1a-4d7e-9f3a-2a1b3c4d5e6f";
const ctx = { params: Promise.resolve({ id: ID }) };

function jsonRequest(payload: unknown): Request & { bodyReads: () => number } {
  const real = new Request(`http://localhost/api/mobile/v1/tasks/${ID}/status`, {
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
  mocks.serverCaller.mockResolvedValue({ tasks: { setStatus: mocks.setStatus } });
  mocks.setStatus.mockResolvedValue({ id: "c-1", taskId: ID, status: "in-progress", note: null,
    overrideReason: null, createdBy: "user-1", createdAt: new Date("2026-10-31T10:00:00Z") });
});

describe("POST /api/mobile/v1/tasks/[id]/status", () => {
  it("401 before reading the body", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const r = jsonRequest({ status: "done" });
    expect((await POST(r, ctx)).status).toBe(401);
    expect(r.bodyReads()).toBe(0);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
  });

  it("task status passes taskId, never id", async () => {
    const res = await POST(jsonRequest({ status: "in-progress", note: "Gebeld" }), ctx);
    expect(res.status).toBe(200);
    expect(mocks.setStatus).toHaveBeenCalledWith({ taskId: ID, status: "in-progress", note: "Gebeld" });
    expect(mocks.setStatus.mock.calls[0][0]).not.toHaveProperty("id");
    // Hand-shaped: the new status and the legal next moves, not the raw row.
    expect(await res.json()).toEqual(
      { taskId: ID, status: "in-progress", validNext: ["waiting", "done", "dropped"] });
  });

  it("task status rejects an override reason field", async () => {
    const res = await POST(jsonRequest({ status: "done", overrideReason: "toch" }), ctx);
    expect(res.status).toBe(400);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("refuses a taskId in the body: the path names the task", async () => {
    const res = await POST(jsonRequest({ status: "done", taskId: "forged" }), ctx);
    expect(res.status).toBe(400);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("an unknown status is 400 before the router", async () => {
    expect((await POST(jsonRequest({ status: "klaar" }), ctx)).status).toBe(400);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("an illegal move maps from BAD_REQUEST", async () => {
    mocks.setStatus.mockRejectedValue(
      new TRPCError({ code: "BAD_REQUEST", message: "the task cannot move done → open" }));
    const res = await POST(jsonRequest({ status: "open" }), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "the task cannot move done → open" });
  });
});
