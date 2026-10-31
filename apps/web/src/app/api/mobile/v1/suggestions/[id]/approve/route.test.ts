import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  get: vi.fn(),
  approveEntry: vi.fn(),
  approveDocumentMeta: vi.fn(),
  approveDebt: vi.fn(),
  approveTask: vi.fn(),
  approveRegistryItem: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));

import { POST } from "./route";

const ID = "0b6f1c7e-3c1a-4d7e-9f3a-2a1b3c4d5e6f";
const DOC_A = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DOC_B = "7a2e4c1d-9b3f-4e8a-a1c2-3d4e5f6a7b8c";
const ctx = { params: Promise.resolve({ id: ID }) };

/** A Request whose body reads are counted, so "before the body" is measurable. */
function jsonRequest(payload: unknown): Request & { bodyReads: () => number } {
  const real = new Request(`http://localhost/api/mobile/v1/suggestions/${ID}/approve`, {
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

const entryProposed = {
  occurredAt: "2026-10-29T13:00:00.000Z", channel: "email", direction: "inbound",
  summary: "Verder vraagt loonstroken", details: "Juni en juli.",
  participantNames: ["Team Opstart"],
  actionItems: [{ description: "Loonstroken sturen", clarity: "clear" }],
  attachmentDocumentIds: [DOC_A],
};

function suggestion(kind: string, proposed: unknown, over: Record<string, unknown> = {}) {
  return { id: ID, kind, status: "pending", rawEmailId: "r-1", promptVersion: "v1",
    documentId: null, proposed, document: null, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ suggestions: {
    get: mocks.get, approveEntry: mocks.approveEntry,
    approveDocumentMeta: mocks.approveDocumentMeta, approveDebt: mocks.approveDebt,
    approveTask: mocks.approveTask, approveRegistryItem: mocks.approveRegistryItem } });
  mocks.get.mockResolvedValue(suggestion("log-entry", entryProposed));
  mocks.approveEntry.mockResolvedValue({ entryId: "e-1" });
  mocks.approveDocumentMeta.mockResolvedValue(undefined);
  mocks.approveDebt.mockResolvedValue({ debtId: "d-1" });
  mocks.approveTask.mockResolvedValue({ id: "t-1" });
});

describe("POST /api/mobile/v1/suggestions/[id]/approve", () => {
  it("401 before reading the body", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const r = jsonRequest({ edits: {} });
    const res = await POST(r, ctx);
    expect(res.status).toBe(401);
    expect(r.bodyReads()).toBe(0);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
  });

  it("approve dispatches on stored kind, ignoring client kind", async () => {
    mocks.get.mockResolvedValue(suggestion("document-meta", { title: "Beschikking.pdf", docType: "beschikking" }));
    const res = await POST(jsonRequest({ kind: "log-entry", edits: {} }), ctx);
    expect(res.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith({ id: ID });
    expect(mocks.approveDocumentMeta).toHaveBeenCalledTimes(1);
    expect(mocks.approveEntry).not.toHaveBeenCalled();
  });

  it("log-entry approve builds entry from proposed plus edits", async () => {
    const res = await POST(jsonRequest({ edits: {
      summary: "Verder vraagt loonstroken juni+juli", attachmentDocumentIds: [DOC_A, DOC_B] } }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entryId: "e-1" });
    expect(mocks.approveEntry).toHaveBeenCalledWith({ id: ID, entry: {
      occurredAt: new Date("2026-10-29T13:00:00.000Z"), channel: "email", direction: "inbound",
      summary: "Verder vraagt loonstroken juni+juli", details: "Juni en juli.",
      source: "gmail-watch", participantPartyIds: [], documentIds: [DOC_A, DOC_B],
      actionItems: [{ description: "Loonstroken sturen", clarity: "clear" }] } });
  });

  it("an empty body approves the proposal as it stands", async () => {
    const res = await POST(jsonRequest(""), ctx);
    expect(res.status).toBe(200);
    expect(mocks.approveEntry.mock.calls[0][0].entry.summary).toBe("Verder vraagt loonstroken");
  });

  it("log-entry approve refuses an edited source", async () => {
    const res = await POST(jsonRequest({ edits: { source: "manual" } }), ctx);
    expect(res.status).toBe(400);
    expect(mocks.approveEntry).not.toHaveBeenCalled();
  });

  it("document-meta approve overlays title and docType", async () => {
    mocks.get.mockResolvedValue(suggestion("document-meta", { title: "image.png", docType: "foto" }));
    await POST(jsonRequest({ edits: { title: "Beschikking.pdf" } }), ctx);
    expect(mocks.approveDocumentMeta).toHaveBeenLastCalledWith(
      { id: ID, title: "Beschikking.pdf", docType: "foto" });
    // A cleared Soort is "no soort", as the web card sends it.
    await POST(jsonRequest({ edits: { docType: "" } }), ctx);
    expect(mocks.approveDocumentMeta).toHaveBeenLastCalledWith(
      { id: ID, title: "image.png", docType: undefined });
  });

  it("document-meta without a proposed title falls back to the document's effective title", async () => {
    mocks.get.mockResolvedValue(suggestion("document-meta", { docType: null },
      { document: { id: DOC_A, title: "scan0001.pdf", effectiveTitle: "Brief CAK.pdf" } }));
    await POST(jsonRequest({}), ctx);
    expect(mocks.approveDocumentMeta).toHaveBeenLastCalledWith(
      { id: ID, title: "Brief CAK.pdf", docType: undefined });
  });

  it("debt approve parses through debtFields", async () => {
    mocks.get.mockResolvedValue(suggestion("debt", {
      key: "iban:NL00", groupBy: "iban", creditorName: "Stam Incasso", claimedCents: 12345,
      references: null, counterpartyName: "STAM", chargeCount: 3 }));
    await POST(jsonRequest({ edits: { creditorName: "Stam Gerechtsdeurwaarders" } }), ctx);
    // Proposal-only keys (key, groupBy, counterpartyName…) are stripped by the
    // schema; they are not edits and never reach the debt.
    expect(mocks.approveDebt).toHaveBeenCalledWith({ id: ID, debt: {
      creditorName: "Stam Gerechtsdeurwaarders", claimedCents: 12345, references: null } });
  });

  it("debt approve refuses a wrongly typed amount", async () => {
    mocks.get.mockResolvedValue(suggestion("debt", { creditorName: "Stam", claimedCents: 100 }));
    const res = await POST(jsonRequest({ edits: { claimedCents: "veel" } }), ctx);
    expect(res.status).toBe(400);
    expect(mocks.approveDebt).not.toHaveBeenCalled();
  });

  it("task approve parses through taskFields", async () => {
    mocks.get.mockResolvedValue(suggestion("task", {
      key: "task:r-1:loonstroken", title: "Loonstroken sturen", details: "",
      dueAt: "2026-11-03", assigneeHint: "martin", rawEmailId: "r-1" }));
    await POST(jsonRequest({ edits: { documentId: DOC_A } }), ctx);
    expect(mocks.approveTask).toHaveBeenCalledWith({ id: ID, task: {
      title: "Loonstroken sturen", details: undefined,
      dueAt: new Date("2026-11-03"), documentId: DOC_A } });
  });

  it("an unknown edit key is 400", async () => {
    for (const [kind, proposed] of [
      ["log-entry", entryProposed],
      ["document-meta", { title: "a.pdf" }],
      ["debt", { creditorName: "Stam" }],
      ["task", { title: "Bellen" }],
    ] as const) {
      mocks.get.mockResolvedValue(suggestion(kind, proposed));
      const res = await POST(jsonRequest({ edits: { status: "approved" } }), ctx);
      expect(res.status, kind).toBe(400);
    }
    expect(mocks.approveEntry).not.toHaveBeenCalled();
    expect(mocks.approveDocumentMeta).not.toHaveBeenCalled();
    expect(mocks.approveDebt).not.toHaveBeenCalled();
    expect(mocks.approveTask).not.toHaveBeenCalled();
  });

  it("edits that are not an object are 400", async () => {
    const res = await POST(jsonRequest({ edits: ["summary"] }), ctx);
    expect(res.status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("registry-item answers 409", async () => {
    mocks.get.mockResolvedValue(suggestion("registry-item", { name: "Netflix" }));
    const res = await POST(jsonRequest({}), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "open op de website" });
    expect(mocks.approveRegistryItem).not.toHaveBeenCalled();
  });

  it("a verdict already given is 409, an unknown suggestion 404", async () => {
    mocks.approveEntry.mockRejectedValue(
      new TRPCError({ code: "CONFLICT", message: "Suggestion not open for review" }));
    expect((await POST(jsonRequest({}), ctx)).status).toBe(409);
    mocks.get.mockRejectedValue(new TRPCError({ code: "NOT_FOUND" }));
    expect((await POST(jsonRequest({}), ctx)).status).toBe(404);
  });

  it("answers no-store", async () => {
    const res = await POST(jsonRequest({}), ctx);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
