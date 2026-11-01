import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  serverCaller: vi.fn(),
  registerUpload: vi.fn(),
  bySourceRef: vi.fn(),
  createVoice: vi.fn(),
  partyGet: vi.fn(),
  storeFile: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: mocks.serverCaller,
}));
vi.mock("@verder/api/src/storage", () => ({ storeFile: mocks.storeFile }));

import { POST } from "./route";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limit";

const CLIENT_ID = "3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b";
const PARTY_ID = "7a2e4c1d-9b3f-4e8a-a1c2-3d4e5f6a7b8c";
const OCCURRED_AT = "2026-11-01T10:15:00.000Z";
const TRANSCRIPT = "Gebeld met Verder over de loonstroken. Ze sturen een mail.";

type Fields = Partial<Record<"clientId" | "occurredAt" | "partyId" | "channel" | "transcript", string>>;

function voiceRequest(
  fields: Fields = {}, audio: File | null = null, contentLength: string | null = "123",
): Request & { formDataCalls: () => number } {
  const form = new FormData();
  const f = { clientId: CLIENT_ID, occurredAt: OCCURRED_AT, partyId: PARTY_ID,
    channel: "call", transcript: TRANSCRIPT, ...fields };
  for (const [k, v] of Object.entries(f)) if (v !== undefined) form.append(k, v);
  if (audio) form.append("audio", audio);
  const headers = new Headers();
  if (contentLength !== null) headers.set("content-length", contentLength);
  let formDataCalls = 0;
  return {
    headers,
    formData: async () => { formDataCalls++; return form; },
    formDataCalls: () => formDataCalls,
  } as unknown as Request & { formDataCalls: () => number };
}

const m4a = () => new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], "gesprek.m4a",
  { type: "audio/mp4" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({
    documents: { registerUpload: mocks.registerUpload, bySourceRef: mocks.bySourceRef },
    suggestions: { createVoice: mocks.createVoice },
    parties: { get: mocks.partyGet },
  });
  mocks.partyGet.mockResolvedValue({ id: PARTY_ID, name: "Verder" });
  mocks.storeFile.mockResolvedValue({ sha256: "ab".repeat(32), relPath: "ab/ab/x" });
  mocks.bySourceRef.mockResolvedValue(null);
  mocks.registerUpload.mockResolvedValue({ id: "doc-1", sourceRef: `phone:${CLIENT_ID}` });
  mocks.createVoice.mockResolvedValue({ id: "sug-1", duplicate: false });
});

describe("POST /api/mobile/v1/entries/voice", () => {
  it("401 first: before the body is read or any router is reached", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const req = voiceRequest({}, m4a());
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(req.formDataCalls()).toBe(0);
    expect(mocks.serverCaller).not.toHaveBeenCalled();
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });

  it("without audio: one pending suggestion, nothing stored", async () => {
    const res = await POST(voiceRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ suggestionId: "sug-1", audioDocumentId: null, duplicate: false });
    expect(mocks.createVoice).toHaveBeenCalledWith({ clientId: CLIENT_ID,
      occurredAt: new Date(OCCURRED_AT), partyId: PARTY_ID, channel: "call",
      transcript: TRANSCRIPT });
    expect(mocks.storeFile).not.toHaveBeenCalled();
    expect(mocks.registerUpload).not.toHaveBeenCalled();
  });

  it("channel defaults to call", async () => {
    await POST(voiceRequest({ channel: undefined }));
    expect(mocks.createVoice).toHaveBeenCalledWith(expect.objectContaining({ channel: "call" }));
  });

  it("audio is stored as phone-voice", async () => {
    const res = await POST(voiceRequest({}, m4a()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestionId: "sug-1", audioDocumentId: "doc-1", duplicate: false });
    expect(mocks.bySourceRef).toHaveBeenCalledWith({ source: "phone-voice", sourceRef: `phone:${CLIENT_ID}` });
    expect(mocks.registerUpload).toHaveBeenCalledWith({
      sha256: "ab".repeat(32), sizeBytes: 8, mime: "audio/mp4", title: "gesprek.m4a",
      source: "phone-voice", sourceRef: `phone:${CLIENT_ID}`, receivedAt: new Date(OCCURRED_AT),
    });
    expect(mocks.createVoice).toHaveBeenCalledWith(expect.objectContaining({ audioDocumentId: "doc-1" }));
  });

  it("a retry with the same clientId stores the audio once", async () => {
    mocks.bySourceRef.mockResolvedValue({ id: "doc-1" });
    mocks.createVoice.mockResolvedValue({ id: "sug-1", duplicate: true });
    const res = await POST(voiceRequest({}, m4a()));
    expect(await res.json()).toEqual({ suggestionId: "sug-1", audioDocumentId: "doc-1", duplicate: true });
    expect(mocks.storeFile).not.toHaveBeenCalled();
    expect(mocks.registerUpload).not.toHaveBeenCalled();
  });

  it("refuses a non-audio file before storing it", async () => {
    const pdf = new File([new TextEncoder().encode("%PDF-1.7")], "x.pdf", { type: "application/pdf" });
    const res = await POST(voiceRequest({}, pdf));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "audio must be an audio file" });
    expect(mocks.storeFile).not.toHaveBeenCalled();
    expect(mocks.createVoice).not.toHaveBeenCalled();
  });

  it("an unknown party is a 400 before the audio is stored", async () => {
    mocks.partyGet.mockRejectedValue(new TRPCError({ code: "NOT_FOUND", message: "Party not found" }));
    const res = await POST(voiceRequest({}, m4a()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "partyId is not a known party" });
    expect(mocks.storeFile).not.toHaveBeenCalled();
    expect(mocks.createVoice).not.toHaveBeenCalled();
  });

  it.each([
    [{ clientId: "nope" }, "clientId must be a UUID"],
    [{ partyId: "nope" }, "partyId must be a UUID"],
    [{ occurredAt: "gisteren" }, "occurredAt must be an ISO 8601 date"],
    [{ channel: "telegram" }, "channel must be one of call, meeting, email, whatsapp, voicemail, letter, other"],
    [{ transcript: "   " }, "transcript must not be empty"],
    [{ transcript: "x".repeat(20_001) }, "transcript is too long"],
  ])("400 on %o", async (fields, error) => {
    const res = await POST(voiceRequest(fields as Fields));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(mocks.createVoice).not.toHaveBeenCalled();
  });

  it("413 above MAX_UPLOAD_BYTES before parsing, 411 without a length", async () => {
    const big = voiceRequest({}, m4a(), String(MAX_UPLOAD_BYTES + 1));
    expect((await POST(big)).status).toBe(413);
    expect(big.formDataCalls()).toBe(0);
    expect((await POST(voiceRequest({}, null, null))).status).toBe(411);
    expect(mocks.createVoice).not.toHaveBeenCalled();
  });
});
