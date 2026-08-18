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

function uploadRequest(file: File, contentLength?: string): Request {
  const form = new FormData();
  form.append("file", file);
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  // Minimal stand-in: the handler only touches headers and formData().
  return {
    headers,
    formData: async () => form,
  } as unknown as Request;
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
});
