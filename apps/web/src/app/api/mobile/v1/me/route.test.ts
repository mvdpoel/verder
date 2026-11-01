import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  loadAccount: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));
vi.mock("@/lib/mobile-account", () => ({ loadAccount: mocks.loadAccount }));

import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const req = () => new Request("http://localhost/api/mobile/v1/me");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({});
  mocks.loadAccount.mockResolvedValue({ email: "martin@example.test", name: "Martin", passkeys: 1 });
});

describe("GET /api/mobile/v1/me", () => {
  it("401 without a session, before the account is read", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(mocks.loadAccount).not.toHaveBeenCalled();
  });

  it("answers the signed-in account, never cached", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ email: "martin@example.test", name: "Martin", passkeys: 1 });
  });

  it("a session that vanished between the two reads is a 401, not a null body", async () => {
    mocks.loadAccount.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
  });
});
