import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  texts: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const req = (q: string) => new Request(`http://localhost/api/mobile/v1/documents/texts${q}`);
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ dossierSync: { texts: mocks.texts } });
  mocks.texts.mockResolvedValue([{ id: A, text: "Uw aanvraag", truncated: false }]);
});

describe("GET /api/mobile/v1/documents/texts", () => {
  it("401 first", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(`?ids=${A}`), ctx);
    expect(res.status).toBe(401);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
  });

  it("splits the ids and answers the texts", async () => {
    const res = await GET(req(`?ids=${A},${B}`), ctx);
    expect(res.status).toBe(200);
    expect(mocks.texts).toHaveBeenCalledWith({ ids: [A, B] });
    expect(await res.json()).toEqual([{ id: A, text: "Uw aanvraag", truncated: false }]);
  });

  it("400 on more than 20 ids, a bad id or none, before the router", async () => {
    const many = Array.from({ length: 21 }, () => A).join(",");
    for (const q of [`?ids=${many}`, "?ids=nope", "?ids=", ""]) {
      const res = await GET(req(q), ctx);
      expect(res.status).toBe(400);
    }
    expect(mocks.texts).not.toHaveBeenCalled();
  });
});
