import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

type Doc = { sha256: string; mime: string; title: string };

const docs = new Map<string, Doc>();

vi.mock("@/lib/trpc-server", () => ({
  serverCaller: async () => ({
    documents: {
      bySha: async ({ sha256 }: { sha256: string }) => {
        const doc = docs.get(sha256);
        if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "no such document" });
        return doc;
      },
    },
  }),
}));

import { storeFile } from "@verder/api/src/storage";
import { GET } from "./[sha256]/route";

let vaultDir: string;

function registerDoc(doc: Doc): void {
  docs.set(doc.sha256, doc);
}

beforeEach(async () => {
  docs.clear();
  vaultDir = await mkdtemp(join(tmpdir(), "verder-files-"));
  process.env.VAULT_DIR = vaultDir;
});

afterEach(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

describe("GET /api/files/[sha256]", () => {
  it("serves a sniffed type inline when the stored mime says nothing", async () => {
    const buf = readFileSync(
      new URL("../../../../../../packages/parsers/fixtures/abn.xls", import.meta.url));
    const { sha256 } = await storeFile(vaultDir, buf);
    registerDoc({ sha256, mime: "application/octet-stream", title: "abn.xls" });

    const res = await GET(new Request("http://localhost/api/files/x"),
      { params: Promise.resolve({ sha256 }) });
    expect(res.headers.get("content-type")).toBe("application/vnd.ms-excel");
    expect(res.headers.get("content-disposition")).toContain("inline");
  });

  it("trusts an informative stored mime rather than re-sniffing", async () => {
    const buf = Buffer.from("%PDF-1.4\nx");
    const { sha256 } = await storeFile(vaultDir, buf);
    registerDoc({ sha256, mime: "application/pdf", title: "letter.pdf" });
    const res = await GET(new Request("http://localhost/api/files/x"),
      { params: Promise.resolve({ sha256 }) });
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("never lets a title inject a header", async () => {
    const buf = Buffer.from("%PDF-1.4\nx");
    const { sha256 } = await storeFile(vaultDir, buf);
    registerDoc({ sha256, mime: "application/pdf", title: 'evil"\r\nX-Injected: yes' });
    const res = await GET(new Request("http://localhost/api/files/x"),
      { params: Promise.resolve({ sha256 }) });
    expect(res.headers.get("x-injected")).toBeNull();
    expect(res.headers.get("content-disposition")).not.toContain("\n");
  });
});
