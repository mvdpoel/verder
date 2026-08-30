import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

type Doc = { id: string; sha256: string; mime: string; effectiveTitle: string;
  effectiveDocType: string | null; effectiveStatus: string; sizeBytes: number;
  receivedAt: Date; effectivePartyId: string | null };

const docs = new Map<string, Doc>();
let missing = new Set<string>();
// Ruling 26: documents.get is a protectedProcedure, so an unauthenticated
// request throws UNAUTHORIZED there. The mock needs to be able to reproduce
// that, distinctly from an ordinary "no such document" failure.
let unauthorized = false;

vi.mock("@/lib/trpc-server", () => ({
  serverCaller: async () => ({
    documents: {
      get: async ({ id }: { id: string }) => {
        const d = docs.get(id);
        if (!d) throw new Error("NOT_FOUND");
        return d;
      },
    },
    parties: {
      list: async () => {
        if (unauthorized) throw new TRPCError({ code: "UNAUTHORIZED" });
        return [];
      },
    },
  }),
}));

import { storeFile } from "@verder/api/src/storage";
import { GET, POST } from "./route";

let vaultDir: string;
beforeEach(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "verder-zip-route-"));
  process.env.VAULT_DIR = vaultDir;
  docs.clear();
  missing = new Set();
  unauthorized = false;
});

const seed = async (title: string) => {
  const { sha256 } = await storeFile(vaultDir, Buffer.from(`bytes of ${title}`));
  const id = crypto.randomUUID();
  docs.set(id, { id, sha256, mime: "application/pdf", effectiveTitle: title,
    effectiveDocType: "brief", effectiveStatus: "filed", sizeBytes: 12,
    receivedAt: new Date("2026-08-01T10:00:00Z"), effectivePartyId: null });
  return id;
};

const form = (ids: string[]) => {
  const body = new URLSearchParams();
  for (const id of ids) body.append("id", id);
  return new Request("http://localhost/api/files/zip", { method: "POST", body });
};

describe("POST /api/files/zip", () => {
  it("returns a zip with the manifest first", async () => {
    const res = await POST(form([await seed("Beschikking"), await seed("Loonstrook")]));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(30, 30 + "inhoudsopgave.txt".length).toString())
      .toBe("inhoudsopgave.txt");
  });

  it("refuses an empty selection", async () => {
    expect((await POST(form([]))).status).toBe(400);
  });

  // Once the response has begun there is no way to report a failure, so this
  // has to happen BEFORE a byte is written. An archive that is quietly one
  // document short is worse than no archive at all.
  it("refuses before streaming when a document's bytes are missing", async () => {
    const good = await seed("Aanwezig");
    const gone = crypto.randomUUID();
    docs.set(gone, { id: gone, sha256: "f".repeat(64), mime: "application/pdf",
      effectiveTitle: "Zoek", effectiveDocType: null, effectiveStatus: "filed",
      sizeBytes: 10, receivedAt: new Date(), effectivePartyId: null });
    const res = await POST(form([good, gone]));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("Zoek");
  });

  it("names the download and does not serve it inline", async () => {
    const res = await POST(form([await seed("Beschikking")]));
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  // Ruling 26: the brief's archive() caught every failure from the tRPC layer
  // — UNAUTHORIZED included — and answered 404 ("Onbekend document in de
  // selectie"). An unauthenticated caller must see 401, not be told the
  // document doesn't exist.
  it("answers 401, not 404, for an unauthenticated request", async () => {
    unauthorized = true;
    const res = await POST(form([await seed("Beschikking")]));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/files/zip", () => {
  it("refuses a request with neither a bundle nor ids", async () => {
    const res = await GET(new Request("http://localhost/api/files/zip"));
    expect(res.status).toBe(400);
  });
});
