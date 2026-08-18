import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  ingest: vi.fn(),
  storeFile: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: async () => ({ registry: { import: { ingest: mocks.ingest } } }),
}));
vi.mock("@verder/api/src/storage", () => ({ storeFile: mocks.storeFile }));

import { POST } from "./route";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limit";

function uploadRequest(file: File, contentLength?: string): Request & { formDataCalls: () => number } {
  const form = new FormData();
  form.append("file", file);
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  let formDataCalls = 0;
  // Minimal stand-in: the handler only touches headers and formData().
  return {
    headers,
    formData: async () => { formDataCalls++; return form; },
    formDataCalls: () => formDataCalls,
  } as unknown as Request & { formDataCalls: () => number };
}

const statementFile = () =>
  new File([new TextEncoder().encode("acct\tEUR\t20260701\t1,00\t0,00\t20260701\t-1,00\tx")],
    "abn.tsv", { type: "text/tab-separated-values" });

const SHA = "ab".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeFile.mockResolvedValue({ sha256: SHA, relPath: "ab/ab/x" });
  mocks.ingest.mockResolvedValue({
    statementSha256: SHA, inserted: 1, skipped: 0, errors: 0, source: "abn-tsv" });
});

describe("POST /api/registry-import", () => {
  it("rejects an invalid session with 401 BEFORE any bytes reach the vault", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await POST(uploadRequest(statementFile(), "123"));
    expect(res.status).toBe(401);
    expect(mocks.storeFile).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("stores the statement vault-first, then ingests it and returns the summary", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    const res = await POST(uploadRequest(statementFile(), "123"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      statementSha256: SHA, inserted: 1, skipped: 0, errors: 0, source: "abn-tsv" });
    expect(mocks.storeFile).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).toHaveBeenCalledWith({ sha256: SHA, filename: "abn.tsv" });
  });

  it("rejects an oversized body with 413 before parsing it", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    const req = uploadRequest(statementFile(), String(MAX_UPLOAD_BYTES + 1));
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(req.formDataCalls()).toBe(0); // body never buffered
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });

  it("rejects a missing content-length with 411", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    const res = await POST(uploadRequest(statementFile()));
    expect(res.status).toBe(411);
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });

  it("rejects an oversized file with 413 even when content-length lies", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    const big = statementFile();
    Object.defineProperty(big, "size", { value: MAX_UPLOAD_BYTES + 1 });
    const res = await POST(uploadRequest(big, "123"));
    expect(res.status).toBe(413);
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });

  it("maps an unrecognized-format TRPCError to a 400 with the message", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    const { TRPCError } = await import("@trpc/server");
    mocks.ingest.mockRejectedValue(new TRPCError({
      code: "BAD_REQUEST", message: "Unrecognized statement format" }));
    const res = await POST(uploadRequest(statementFile(), "123"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unrecognized statement format" });
  });
});
