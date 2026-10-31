import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { GET } from "./route";

const ID = "0b6f1c7e-3c1a-4d7e-9f3a-2a1b3c4d5e6f";
const DOC_ID = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ctx = { params: Promise.resolve({ id: ID }) };
const req = () => new Request(`http://localhost/api/mobile/v1/suggestions/${ID}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ suggestions: { get: mocks.get } });
  mocks.get.mockResolvedValue({
    id: ID, kind: "log-entry", status: "pending",
    createdAt: new Date("2026-10-30T08:15:00.000Z"),
    proposed: { summary: "Verder vraagt loonstroken" },
    finalPayload: null, model: "qwen3.5:9b",
    retrievedRefs: [{ entityType: "document", entityId: DOC_ID }],
    rawEmail: { id: "r-1", fromAddr: "demi@verdergroep.nl", subject: "Loonstroken",
      sentAt: new Date("2026-10-29T13:00:00.000Z"), bodyText: "Graag de loonstroken." },
    document: { id: DOC_ID, status: "inbox", effectiveStatus: "filed",
      effectiveTitle: "Loonstrook", effectiveDocType: "loonstrook", sha256: "ab".repeat(32) },
  });
});

describe("GET /api/mobile/v1/suggestions/[id]", () => {
  it("401 without a session, before any router call", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("passes the id from the path and answers the hand-shaped DTO", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith({ id: ID });
    const body = await res.json();
    expect(body).toEqual({
      id: ID, kind: "log-entry", status: "pending", createdAt: "2026-10-30T08:15:00.000Z",
      proposed: { summary: "Verder vraagt loonstroken" },
      trigger: { from: "demi@verdergroep.nl", subject: "Loonstroken",
        sentAt: "2026-10-29T13:00:00.000Z" },
      document: { id: DOC_ID, title: "Loonstrook", docType: "loonstrook", status: "filed" },
      retrievedRefs: [{ entityType: "document", entityId: DOC_ID }],
    });
  });

  it("dates serialise as ISO strings", async () => {
    const body = await (await GET(req(), ctx)).json();
    expect(body.createdAt).toBe("2026-10-30T08:15:00.000Z");
    expect(body.trigger.sentAt).toBe("2026-10-29T13:00:00.000Z");
  });

  it("suggestion 404 maps from NOT_FOUND", async () => {
    mocks.get.mockRejectedValue(new TRPCError({ code: "NOT_FOUND" }));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("400 maps from BAD_REQUEST (a malformed id)", async () => {
    mocks.get.mockRejectedValue(new TRPCError({ code: "BAD_REQUEST", message: "invalid uuid" }));
    expect((await GET(req(), ctx)).status).toBe(400);
  });
});
