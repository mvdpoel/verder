import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TRPCError } from "@trpc/server";
import { relPathFor } from "@verder/api/src/storage";

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

const ID = "33333333-3333-4333-8333-333333333333";
const SHA = "b".repeat(64);
const BYTES = Buffer.from("%PDF-1.4 fixture");
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const req = () => new Request(`http://localhost/api/mobile/v1/documents/${ID}/file`);
const doc = (over: Record<string, unknown> = {}) => ({
  id: ID, sha256: SHA, mime: "application/pdf", effectiveStatus: "filed",
  effectiveTitle: "Beschikking (2026)", purge: null, ...over,
});

let prevVault: string | undefined;
beforeAll(async () => {
  prevVault = process.env.VAULT_DIR;
  process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "vault-mobile-file-"));
  const abs = join(process.env.VAULT_DIR, relPathFor(SHA));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, BYTES);
});
afterAll(() => { process.env.VAULT_DIR = prevVault; });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.serverCaller.mockResolvedValue({ documents: { get: mocks.get } });
  mocks.get.mockResolvedValue(doc());
});

describe("GET /api/mobile/v1/documents/[id]/file", () => {
  it("401 first", async () => {
    mocks.getSessionUserId.mockResolvedValue(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mocks.serverCaller).not.toHaveBeenCalled();
  });

  it("serves the bytes with a safe type, the effective title and nosniff", async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith({ id: ID });
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition"))
      .toBe("inline; filename*=UTF-8''Beschikking%20%282026%29");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("file 410 for purged", async () => {
    mocks.get.mockResolvedValue(doc({ purge: { at: new Date(), reason: null, sha256: SHA,
      sizeBytes: 1, bytesStillOnDisk: true } }));
    const res = await GET(req(), ctx());
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "purged" });
  });

  it("404 for a discarded document, never its bytes", async () => {
    mocks.get.mockResolvedValue(doc({ effectiveStatus: "discarded" }));
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
  });

  it("404 for an unknown id and for a malformed one", async () => {
    mocks.get.mockRejectedValue(new TRPCError({ code: "NOT_FOUND" }));
    expect((await GET(req(), ctx())).status).toBe(404);
    mocks.get.mockClear();
    expect((await GET(req(), ctx("../etc"))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("an unsafe stored mime is served as octet-stream, attached", async () => {
    mocks.get.mockResolvedValue(doc({ mime: "text/html\r\nX-Evil: 1" }));
    const res = await GET(req(), ctx());
    expect(res.headers.get("content-type")).not.toContain("html");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });
});
