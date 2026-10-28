import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  registerUpload: vi.fn(),
  bySourceRef: vi.fn(),
  storeFile: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: async () => ({
    documents: { registerUpload: mocks.registerUpload, bySourceRef: mocks.bySourceRef },
  }),
}));
vi.mock("@verder/api/src/storage", () => ({ storeFile: mocks.storeFile }));

import { POST } from "./route";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limit";

const CLIENT_ID = "3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b";
const CAPTURED_AT = "2026-10-28T09:15:00.000Z";

type Fields = { clientId?: string; source?: string; capturedAt?: string };

function phoneRequest(
  file: File, fields: Fields = {}, contentLength: string | null = "123",
): Request & { formDataCalls: () => number } {
  const form = new FormData();
  form.append("file", file);
  const f = { clientId: CLIENT_ID, source: "phone-scan", capturedAt: CAPTURED_AT, ...fields };
  for (const [k, v] of Object.entries(f)) if (v !== undefined) form.append(k, v);
  const headers = new Headers();
  if (contentLength !== null) headers.set("content-length", contentLength);
  let formDataCalls = 0;
  return {
    headers,
    formData: async () => { formDataCalls++; return form; },
    formDataCalls: () => formDataCalls,
  } as unknown as Request & { formDataCalls: () => number };
}

const pdf = () => new File([new TextEncoder().encode("%PDF-1.7 brief")], "brief.pdf", { type: "application/pdf" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.storeFile.mockResolvedValue({ sha256: "ab".repeat(32), relPath: "ab/ab/x" });
  mocks.bySourceRef.mockResolvedValue(null);
  mocks.registerUpload.mockResolvedValue({ id: "doc-1", sourceRef: `phone:${CLIENT_ID}` });
});

describe("POST /api/mobile/v1/documents", () => {
  it("401 before any bytes reach the vault", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const req = phoneRequest(pdf());
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(req.formDataCalls()).toBe(0);
    expect(mocks.storeFile).not.toHaveBeenCalled();
    expect(mocks.registerUpload).not.toHaveBeenCalled();
  });

  it("400 when clientId is not a UUID", async () => {
    const res = await POST(phoneRequest(pdf(), { clientId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "clientId must be a UUID" });
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });

  it("400 when source is not a phone source", async () => {
    const res = await POST(phoneRequest(pdf(), { source: "upload" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "source must be phone-scan or phone-share" });
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });

  it("400 when capturedAt is not a date", async () => {
    const res = await POST(phoneRequest(pdf(), { capturedAt: "gisteren" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "capturedAt must be an ISO 8601 date" });
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });

  it("stores and registers with sourceRef phone:<clientId> and receivedAt = capturedAt", async () => {
    const res = await POST(phoneRequest(pdf(), { source: "phone-share" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "doc-1", duplicate: false });
    expect(mocks.bySourceRef).toHaveBeenCalledWith({ source: "phone-share", sourceRef: `phone:${CLIENT_ID}` });
    expect(mocks.storeFile).toHaveBeenCalledTimes(1);
    expect(mocks.registerUpload).toHaveBeenCalledWith({
      sha256: "ab".repeat(32), sizeBytes: 14, mime: "application/pdf", title: "brief.pdf",
      source: "phone-share", sourceRef: `phone:${CLIENT_ID}`, receivedAt: new Date(CAPTURED_AT),
    });
  });

  it("same clientId twice yields one document", async () => {
    const first = await POST(phoneRequest(pdf()));
    expect(await first.json()).toEqual({ id: "doc-1", duplicate: false });
    mocks.bySourceRef.mockResolvedValue({ id: "doc-1" });
    const second = await POST(phoneRequest(pdf()));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ id: "doc-1", duplicate: true });
    expect(mocks.storeFile).toHaveBeenCalledTimes(1);
    expect(mocks.registerUpload).toHaveBeenCalledTimes(1);
  });

  it("reports duplicate when the bytes are already in the vault under another source", async () => {
    mocks.registerUpload.mockResolvedValue({ id: "doc-7", sourceRef: "loondossier:123" });
    const res = await POST(phoneRequest(pdf()));
    expect(await res.json()).toEqual({ id: "doc-7", duplicate: true });
  });

  it("413 above MAX_UPLOAD_BYTES before parsing", async () => {
    const req = phoneRequest(pdf(), {}, String(MAX_UPLOAD_BYTES + 1));
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(req.formDataCalls()).toBe(0);
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });

  it("411 without a content-length", async () => {
    const res = await POST(phoneRequest(pdf(), {}, null));
    expect(res.status).toBe(411);
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });
});
