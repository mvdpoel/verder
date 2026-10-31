import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionIdentity: vi.fn<() => Promise<{ userId: string; sessionId: string } | null>>(),
  registerDevice: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionIdentity: mocks.getSessionIdentity,
  serverCaller: async () => ({ push: { registerDevice: mocks.registerDevice } }),
}));

import { POST } from "./route";
import { MAX_REGISTER_BODY_BYTES } from "@/lib/upload-limit";
import { registerDeviceInput } from "@verder/api/src/routers/push";

const TOKEN = "0a1b2c3d".repeat(8);
const body = (over: Record<string, unknown> = {}) => ({
  token: TOKEN, environment: "development", bundleId: "pro.vanderpoel.verder",
  appVersion: "1.0 (1)", ...over });

/** A Request whose body reads are counted, so "before the body" is measurable. */
function jsonRequest(payload: unknown): Request & { bodyReads: () => number } {
  const real = new Request("http://localhost/api/mobile/v1/push/register", {
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

// The real procedure's validation, applied the way tRPC would apply it, so the
// 400 tests exercise the actual token rule rather than a copy of it.
function parseLikeTrpc(input: unknown) {
  const r = registerDeviceInput.safeParse(input);
  if (!r.success) throw new TRPCError({ code: "BAD_REQUEST", message: "invalid input" });
  return { id: "device-1" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionIdentity.mockResolvedValue({ userId: "user-1", sessionId: "sess-cookie" });
  mocks.registerDevice.mockImplementation(async (input: unknown) => parseLikeTrpc(input));
});

describe("POST /api/mobile/v1/push/register", () => {
  it("401 before reading the body", async () => {
    mocks.getSessionIdentity.mockResolvedValue(null);
    const req = jsonRequest(body());
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(req.bodyReads()).toBe(0);
    expect(mocks.registerDevice).not.toHaveBeenCalled();
  });

  it("400 on an uppercase or short token", async () => {
    const upper = await POST(jsonRequest(body({ token: TOKEN.toUpperCase() })));
    expect(upper.status).toBe(400);
    const short = await POST(jsonRequest(body({ token: "ab".repeat(16) })));
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "invalid input" });
  });

  it("passes the session id from the cookie, never from the body", async () => {
    const res = await POST(jsonRequest(body({ sessionId: "sess-forged" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "device-1" });
    expect(mocks.registerDevice).toHaveBeenCalledWith({
      token: TOKEN, environment: "development", bundleId: "pro.vanderpoel.verder",
      appVersion: "1.0 (1)", sessionId: "sess-cookie" });
  });

  it("400 on a body that is not JSON", async () => {
    const res = await POST(jsonRequest("{nope"));
    expect(res.status).toBe(400);
    expect(mocks.registerDevice).not.toHaveBeenCalled();
  });

  it("400 on a JSON body that is not an object", async () => {
    const res = await POST(jsonRequest([1, 2]));
    expect(res.status).toBe(400);
    expect(mocks.registerDevice).not.toHaveBeenCalled();
  });

  it("413 above the body limit, without calling the router", async () => {
    const res = await POST(jsonRequest(body({ appVersion: "x".repeat(MAX_REGISTER_BODY_BYTES) })));
    expect(res.status).toBe(413);
    expect(mocks.registerDevice).not.toHaveBeenCalled();
  });

  it("401 when the router finds no user", async () => {
    mocks.registerDevice.mockRejectedValue(new TRPCError({ code: "UNAUTHORIZED" }));
    const res = await POST(jsonRequest(body()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
