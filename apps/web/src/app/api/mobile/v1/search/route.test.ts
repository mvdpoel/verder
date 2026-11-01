import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const req = (q: string) => new Request(`http://localhost/api/mobile/v1/search${q}`);
const DOC = "44444444-4444-4444-8444-444444444444";
const TASK = "55555555-5555-4555-8555-555555555555";
const ENTRY = "66666666-6666-4666-8666-666666666666";

const hit = (entityType: string, entityId: string, href: string) => ({
  entityType, entityId, title: `${entityType} titel`, snippet: "… «beschikking» …",
  occurredAt: "2026-07-14T08:00:00.000Z", status: null, score: 0.5,
  matchedBy: "keyword", href,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ search: { query: mocks.query } });
  mocks.query.mockResolvedValue({
    hits: [hit("document", DOC, `/files/${DOC}`), hit("task", TASK, `/tasks/${TASK}`),
      hit("entry", ENTRY, `/logbook/${ENTRY}`)],
    nextCursor: "MjA=", semanticAvailable: true, reranked: false, rerankPromptVersion: null,
  });
});

describe("GET /api/mobile/v1/search", () => {
  it("401 first", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req("?q=beschikking"), ctx);
    expect(res.status).toBe(401);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
  });

  it("asks search.query in fast mode, never deep", async () => {
    await GET(req("?q=%20beschikking%20&cursor=MjA%3D"), ctx);
    expect(mocks.query).toHaveBeenCalledWith({ q: "beschikking", mode: "fast", limit: 20, cursor: "MjA=" });
  });

  it("maps hits to app routes instead of web hrefs", async () => {
    const res = await GET(req("?q=beschikking"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBe("MjA=");
    expect(body.hits.map((h: { link: string | null }) => h.link)).toEqual([
      `verder://document/${DOC}`, `verder://task/${TASK}`, null]);
    for (const h of body.hits) expect(h).not.toHaveProperty("href");
    expect(body.hits[0]).toEqual({
      entityType: "document", entityId: DOC, title: "document titel",
      snippet: "… «beschikking» …", occurredAt: "2026-07-14T08:00:00.000Z", status: null,
      link: `verder://document/${DOC}`,
    });
  });

  it("400 on an empty or overlong query, before the router", async () => {
    for (const q of ["", "?q=", "?q=%20%20", `?q=${"x".repeat(501)}`]) {
      expect((await GET(req(q), ctx)).status).toBe(400);
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("a router BAD_REQUEST answers 400", async () => {
    mocks.query.mockRejectedValue(new TRPCError({ code: "BAD_REQUEST", message: "bad cursor" }));
    expect((await GET(req("?q=x"), ctx)).status).toBe(400);
  });
});
