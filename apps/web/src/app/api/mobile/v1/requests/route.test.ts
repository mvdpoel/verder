import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  list: vi.fn(), create: vi.fn(), get: vi.fn(), cancel: vi.fn(), markOpened: vi.fn(),
  step: vi.fn(), dismiss: vi.fn(), undismiss: vi.fn(), retry: vi.fn(), attachable: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({ getSessionUserId: mocks.getSessionUserId, serverCaller: mocks.serverCaller }));

import { GET, POST } from "./route";
import { GET as GET_ONE } from "./[id]/route";
import { POST as CANCEL } from "./[id]/cancel/route";
import { POST as OPENED } from "./[id]/opened/route";
import { POST as STEPS } from "./[id]/steps/route";
import { POST as DISMISS } from "./[id]/dismiss/route";
import { POST as UNDISMISS } from "./[id]/undismiss/route";
import { POST as RETRY } from "./[id]/retry/route";
import { GET as ATTACHABLE } from "./attachable/route";

const ID = "00000000-f1c5-4000-8000-a00000000001";
const CLIENT = "6f0b7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const none = { params: Promise.resolve({}) };
const withId = { params: Promise.resolve({ id: ID }) };
const post = (body: unknown) => new Request("http://localhost/api/mobile/v1/requests",
  { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });
const row = {
  id: ID, rootId: ID, text: "Zeg het abonnement op", title: "Abonnement", status: "answered",
  phase: "todo", todoReason: "unread", doneReason: null, meta: "Nieuw antwoord · 1 voorstel", parentRequestId: null,
  createdAt: new Date("2026-11-04T09:00:00Z"), at: new Date("2026-11-04T09:03:00Z"),
  answeredAt: new Date("2026-11-04T09:03:00Z"), openedAt: null, dismissedAt: null, unread: true,
  stepsTotal: 0, stepsDone: 0, proposal: { id: "p1", status: "pending", priority: "verder" }, followUps: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ requests: { list: mocks.list, create: mocks.create, get: mocks.get,
    cancel: mocks.cancel, markOpened: mocks.markOpened, step: mocks.step, dismiss: mocks.dismiss,
    undismiss: mocks.undismiss, retry: mocks.retry, attachable: mocks.attachable } });
});

describe("/api/mobile/v1/requests", () => {
  it("401 before touching the router, on every route", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    for (const res of [await GET(new Request("http://localhost/x"), none), await POST(post({ text: "x" }), none),
      await GET_ONE(new Request("http://localhost/x"), withId), await CANCEL(post({}), withId), await OPENED(post({}), withId),
      await STEPS(post({ index: 0, done: true }), withId), await DISMISS(post({}), withId),
      await UNDISMISS(post({}), withId), await RETRY(post({ clientId: CLIENT }), withId),
      await ATTACHABLE(new Request("http://localhost/x"), none)]) {
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
    const steps = [{ label: "Leest 2 documenten", state: "done" }, { label: "Zoekt live in Gmail…", state: "current" }];
    mocks.get.mockResolvedValue({ ...row, clientId: CLIENT, headline: null, claimedAt: null, updatedAt: row.createdAt,
      status: "working", unread: false, progressLine: null, failure: null, failureDetail: null, about: null, answer: null,
      sources: [], martinSteps: [], steps: [], proposal: null, proposalUpdating: false,
      progress: { calls: 3, documents: 2, mails: 0, gmail: 1, line: "leest 2 documenten", steps },
      thread: [], followUps: [] });
    const res = await GET_ONE(new Request("http://localhost/x"), withId);
    expect((await res.json()).progress).toEqual({ calls: 3, documents: 2, mails: 0, liveMail: 1, line: "leest 2 documenten", steps });
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

  it("steps, dismiss, undismiss, retry and attachable", async () => {
    mocks.step.mockResolvedValue({ id: ID, index: 0, doneAt: "2026-11-04T10:00:00.000Z" });
    expect(await (await STEPS(post({ index: 0, done: true }), withId)).json()).toMatchObject({ index: 0 });
    expect(mocks.step).toHaveBeenCalledWith({ id: ID, index: 0, done: true });
    expect((await STEPS(post({ index: -1, done: true }), withId)).status).toBe(400);
    expect((await STEPS(post({ index: 0 }), withId)).status).toBe(400);
    mocks.dismiss.mockResolvedValue({ id: ID, status: "answered", dismissedAt: new Date("2026-11-04T10:00:00Z") });
    expect(await (await DISMISS(post({}), withId)).json()).toEqual({ id: ID, status: "answered", dismissedAt: "2026-11-04T10:00:00.000Z" });
    mocks.undismiss.mockResolvedValue({ id: ID, dismissedAt: null });
    expect(await (await UNDISMISS(post({}), withId)).json()).toEqual({ id: ID, dismissedAt: null });
    mocks.retry.mockResolvedValue({ id: "new", status: "queued", duplicate: false });
    expect(await (await RETRY(post({ clientId: CLIENT }), withId)).json()).toEqual({ id: "new", status: "queued", duplicate: false });
    expect((await RETRY(post({}), withId)).status).toBe(400);
    mocks.attachable.mockResolvedValue([{ type: "mail", id: ID, label: "Boedelbeschrijving", meta: [], at: null }]);
    expect((await (await ATTACHABLE(new Request("http://localhost/x"), none)).json()).items).toHaveLength(1);
  });
});
