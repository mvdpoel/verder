import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  list: vi.fn(), create: vi.fn(), get: vi.fn(), cancel: vi.fn(), markOpened: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({ getSessionUserId: mocks.getSessionUserId, serverCaller: mocks.serverCaller }));

import { GET, POST } from "./route";
import { GET as GET_ONE } from "./[id]/route";
import { POST as CANCEL } from "./[id]/cancel/route";
import { POST as OPENED } from "./[id]/opened/route";

const ID = "00000000-f1c5-4000-8000-a00000000001";
const CLIENT = "6f0b7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const none = { params: Promise.resolve({}) };
const withId = { params: Promise.resolve({ id: ID }) };
const post = (body: unknown) => new Request("http://localhost/api/mobile/v1/requests",
  { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });
const row = {
  id: ID, clientId: CLIENT, text: "Zeg het abonnement op", status: "answered", parentRequestId: null,
  createdAt: new Date("2026-11-04T09:00:00Z"), claimedAt: new Date("2026-11-04T09:01:00Z"),
  answeredAt: new Date("2026-11-04T09:03:00Z"), openedAt: null, unread: true, progressLine: null, failure: null,
  proposal: { id: "p1", status: "pending" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ requests: { list: mocks.list, create: mocks.create, get: mocks.get,
    cancel: mocks.cancel, markOpened: mocks.markOpened } });
});

describe("/api/mobile/v1/requests", () => {
  it("401 before touching the router, on every route", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    for (const res of [await GET(new Request("http://localhost/x"), none), await POST(post({ text: "x" }), none),
      await GET_ONE(new Request("http://localhost/x"), withId), await CANCEL(post({}), withId), await OPENED(post({}), withId)]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(mocks.serverCaller).not.toHaveBeenCalled();
  });

  it("GET lists requests with ISO instants", async () => {
    mocks.list.mockResolvedValue([row]);
    const res = await GET(new Request("http://localhost/x"), none);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).requests[0]).toMatchObject({ id: ID, unread: true, answeredAt: "2026-11-04T09:03:00.000Z",
      proposal: { id: "p1", status: "pending" } });
  });

  it("POST creates idempotently on clientId and refuses an unknown field or a bad body", async () => {
    mocks.create.mockResolvedValue({ id: ID, status: "queued", duplicate: false });
    const res = await POST(post({ clientId: CLIENT, text: " Zeg het op ", about: { documentId: ID } }), none);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, status: "queued", duplicate: false });
    expect(mocks.create).toHaveBeenCalledWith({ clientId: CLIENT, text: "Zeg het op", about: { documentId: ID } });
    expect((await POST(post({ clientId: CLIENT, text: "x", send: true }), none)).status).toBe(400);
    expect((await POST(post({ clientId: "nope", text: "x" }), none)).status).toBe(400);
    expect((await POST(post("not json"), none)).status).toBe(400);
    mocks.create.mockRejectedValue(new TRPCError({ code: "CONFLICT", message: "the request this follows up is working" }));
    expect((await POST(post({ clientId: CLIENT, text: "x", parentRequestId: ID }), none)).status).toBe(409);
  });

  it("GET one maps progress for the phone; 404 maps from NOT_FOUND", async () => {
    mocks.get.mockResolvedValue({ ...row, status: "working", unread: false, about: null, answer: null, sources: [],
      martinSteps: [], proposal: null, progress: { calls: 3, documents: 2, mails: 0, gmail: 1, line: "leest 2 documenten" },
      thread: [], followUps: [] });
    const res = await GET_ONE(new Request("http://localhost/x"), withId);
    expect((await res.json()).progress).toEqual({ calls: 3, documents: 2, mails: 0, liveMail: 1, line: "leest 2 documenten" });
    expect(mocks.get).toHaveBeenCalledWith({ id: ID });
    mocks.get.mockRejectedValue(new TRPCError({ code: "NOT_FOUND" }));
    expect((await GET_ONE(new Request("http://localhost/x"), withId)).status).toBe(404);
  });

  it("cancel and opened", async () => {
    mocks.cancel.mockResolvedValue({ id: ID, status: "cancelled" });
    expect(await (await CANCEL(post({}), withId)).json()).toEqual({ id: ID, status: "cancelled" });
    mocks.cancel.mockRejectedValue(new TRPCError({ code: "CONFLICT", message: "request is answered" }));
    expect((await CANCEL(post({}), withId)).status).toBe(409);
    mocks.markOpened.mockResolvedValue({ id: ID, openedAt: new Date("2026-11-04T10:00:00Z") });
    expect(await (await OPENED(post(""), withId)).json()).toEqual({ id: ID, openedAt: "2026-11-04T10:00:00.000Z" });
  });
});
