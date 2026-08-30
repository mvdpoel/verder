import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

type Doc = { id: string; sha256: string; mime: string; effectiveTitle: string;
  effectiveDocType: string | null; effectiveStatus: string; sizeBytes: number;
  receivedAt: Date; effectivePartyId: string | null };

type Bundle = { id: string; name: string; documentIds: string[]; broken: string | null };

const docs = new Map<string, Doc>();
const bundles = new Map<string, Bundle>();
let missing = new Set<string>();
// Ruling 26: documents.get, parties.list and bundles.get are all
// protectedProcedure calls, so an unauthenticated request throws
// UNAUTHORIZED at whichever of them the request path reaches first. The mock
// needs to be able to reproduce that, distinctly from an ordinary
// "no such document"/"no such bundle" failure.
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
    bundles: {
      get: async ({ id }: { id: string }) => {
        if (unauthorized) throw new TRPCError({ code: "UNAUTHORIZED" });
        const b = bundles.get(id);
        if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "Bundle not found" });
        return b;
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
  bundles.clear();
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

const getBundle = (bundleId: string) =>
  GET(new Request(`http://localhost/api/files/zip?bundle=${bundleId}`));

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
    // The status check alone only implies nothing was streamed. This makes
    // it a check rather than an inference: a 409 whose Content-Type were
    // still application/zip would mean an archive body escaped anyway.
    expect(res.headers.get("Content-Type")).not.toBe("application/zip");
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

  it("returns a zip named after the bundle, with the manifest first", async () => {
    const a = await seed("Beschikking");
    const b = await seed("Loonstrook");
    const bundleId = crypto.randomUUID();
    bundles.set(bundleId, { id: bundleId, name: "Team Opstart", documentIds: [a, b], broken: null });

    const res = await getBundle(bundleId);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(30, 30 + "inhoudsopgave.txt".length).toString())
      .toBe("inhoudsopgave.txt");
    // The bundle's own name, not the date-stamped ad-hoc fallback the POST
    // path uses — computed the same way the route computes it, so this fails
    // if the encoding ever changes rather than pinning today's output.
    const expectedFilename = encodeURIComponent("Team Opstart.zip").replace(/['()*]/g, escape);
    expect(res.headers.get("Content-Disposition"))
      .toBe(`attachment; filename*=UTF-8''${expectedFilename}`);
  });

  // Mirror of the POST unauthenticated test: bundles.get is the call this
  // path reaches first, and it is exactly the call-site the reviewer flagged
  // as easiest to miss.
  it("answers 401, not 404, for an unauthenticated request", async () => {
    unauthorized = true;
    const bundleId = crypto.randomUUID();
    const res = await getBundle(bundleId);
    expect(res.status).toBe(401);
  });

  it("refuses readably, not with an empty or malformed archive, when a bundle matches nothing", async () => {
    const bundleId = crypto.randomUUID();
    bundles.set(bundleId, { id: bundleId, name: "Leeg", documentIds: [], broken: null });
    const res = await getBundle(bundleId);
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).not.toBe("application/zip");
    expect(await res.text()).toContain("geen stukken");
  });

  it("names the problem, rather than reusing the empty-selection message, when a bundle's rule is unreadable", async () => {
    const bundleId = crypto.randomUUID();
    bundles.set(bundleId, {
      id: bundleId, name: "Kapot", documentIds: [],
      broken: "regel: verplicht veld ontbreekt",
    });
    const res = await getBundle(bundleId);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("regel: verplicht veld ontbreekt");
    expect(body).not.toContain("Er is niets geselecteerd");
  });
});
