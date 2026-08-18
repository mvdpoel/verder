import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn<() => Promise<string | null>>(),
  registerUpload: vi.fn(),
  storeFile: vi.fn(),
}));

vi.mock("@/lib/trpc-server", () => ({
  getSessionUserId: mocks.getSessionUserId,
  serverCaller: async () => ({ documents: { registerUpload: mocks.registerUpload } }),
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

const smallFile = () => new File([new TextEncoder().encode("hello vault")], "a.txt", { type: "text/plain" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeFile.mockResolvedValue({ sha256: "ab".repeat(32), relPath: "ab/ab/x" });
  mocks.registerUpload.mockResolvedValue({ id: "doc-1" });
});

describe("POST /api/upload", () => {
  it("rejects an invalid session with 401 BEFORE any bytes reach the vault", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await POST(uploadRequest(smallFile(), "123"));
    expect(res.status).toBe(401);
    expect(mocks.storeFile).not.toHaveBeenCalled();
    expect(mocks.registerUpload).not.toHaveBeenCalled();
  });

  it("stores the file and registers the document for a valid session", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    const res = await POST(uploadRequest(smallFile(), "123"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "doc-1" });
    expect(mocks.storeFile).toHaveBeenCalledTimes(1);
    expect(mocks.registerUpload).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized body with 413 before parsing it", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    const req = uploadRequest(smallFile(), String(MAX_UPLOAD_BYTES + 1));
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(req.formDataCalls()).toBe(0); // body never buffered
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });

  it("rejects a missing content-length with 411", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    const res = await POST(uploadRequest(smallFile()));
    expect(res.status).toBe(411);
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });

  it("rejects an oversized file with 413 even when content-length lies", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    const big = smallFile();
    Object.defineProperty(big, "size", { value: MAX_UPLOAD_BYTES + 1 });
    const res = await POST(uploadRequest(big, "123"));
    expect(res.status).toBe(413);
    expect(mocks.storeFile).not.toHaveBeenCalled();
  });
});
