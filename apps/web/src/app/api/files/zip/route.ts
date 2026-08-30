import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { buildZip, zipEntryName, ZIP_MAX_ENTRIES } from "@verder/core";
import { readFilePath } from "@verder/api/src/storage";
import { serverCaller } from "@/lib/trpc-server";
import { buildManifest, type ManifestRow } from "@/lib/zip-manifest";

/**
 * One archive, of a bundle or of an ad-hoc selection.
 *
 * ROUTE PRECEDENCE: this sits beside /api/files/[sha256]. Next resolves a
 * static segment before a dynamic one, so "zip" never enters that handler —
 * and even if it did, "zip" is not 64 hex characters and documents.bySha would
 * 404. The arrangement looks ambiguous and is not.
 *
 * A form POST rather than fetch+blob: it streams natively, shows the browser's
 * own download progress and works without JavaScript.
 */

const MAX_IDS = ZIP_MAX_ENTRIES;

type Caller = Awaited<ReturnType<typeof serverCaller>>;
type DocRow = Awaited<ReturnType<Caller["documents"]["get"]>>;
type PartyRow = Awaited<ReturnType<Caller["parties"]["list"]>>[number];

/**
 * Ruling 26: the same discipline apps/web/src/app/api/files/[sha256]/route.ts
 * already applies. An UNAUTHORIZED thrown by a protectedProcedure must reach
 * the caller as 401 — never be folded into a generic "not found" the way a
 * blanket try/catch would. Anything that isn't a TRPCError, or is a TRPCError
 * with some other code, is rethrown rather than swallowed.
 */
function mapTrpcError(e: unknown, notFoundMessage: string): NextResponse | null {
  if (e instanceof TRPCError) {
    if (e.code === "UNAUTHORIZED") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (e.code === "NOT_FOUND" || e.code === "BAD_REQUEST") {
      return NextResponse.json({ error: notFoundMessage }, { status: 404 });
    }
  }
  return null;
}

async function archive(ids: string[], name: string): Promise<NextResponse> {
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "Er is niets geselecteerd om te downloaden" }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `Te veel bestanden in één zip (maximum ${MAX_IDS})` }, { status: 400 });
  }

  let parties: PartyRow[];
  const docs: DocRow[] = [];
  try {
    const caller = await serverCaller(); // protectedProcedure rejects the unauthenticated
    parties = await caller.parties.list();
    for (const id of ids) {
      docs.push(await caller.documents.get({ id }));
    }
  } catch (e) {
    const mapped = mapTrpcError(e, "Onbekend document in de selectie");
    if (mapped) return mapped;
    throw e;
  }
  const partyName = new Map(parties.map((p) => [p.id, p.name]));

  // EVERY file is read before ONE byte is written. Once the response has begun
  // there is no way to report a failure, and an archive that is quietly one
  // document short is worse than no archive at all — the discipline
  // nightly-verify applies to the vault.
  const vaultDir = process.env.VAULT_DIR ?? "./vault-files";
  const loaded: { doc: DocRow; bytes: Buffer }[] = [];
  const gone: string[] = [];
  for (const doc of docs) {
    try {
      loaded.push({ doc, bytes: await readFile(readFilePath(vaultDir, doc.sha256)) });
    } catch {
      gone.push(doc.effectiveTitle);
    }
  }
  if (gone.length > 0) {
    return NextResponse.json({
      error: "Deze stukken staan wel in het dossier maar hun bestand ontbreekt in de kluis",
      missing: gone,
    }, { status: 409 });
  }

  const taken = new Set<string>();
  const rows: ManifestRow[] = [];
  const entries = loaded.map(({ doc, bytes }) => {
    const entryName = zipEntryName(doc.effectiveTitle, doc.mime, taken);
    rows.push({
      name: entryName, title: doc.effectiveTitle, docType: doc.effectiveDocType,
      partyName: doc.effectivePartyId ? partyName.get(doc.effectivePartyId) ?? null : null,
      receivedAt: new Date(doc.receivedAt), sizeBytes: doc.sizeBytes,
      sha256: doc.sha256, discarded: doc.effectiveStatus === "discarded",
    });
    return { name: entryName, bytes, at: new Date(doc.receivedAt) };
  });

  let zip: Buffer;
  try {
    zip = buildZip([
      { name: "inhoudsopgave.txt",
        bytes: new TextEncoder().encode(buildManifest(rows, new Date())) },
      ...entries,
    ]);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Kon de zip niet maken" }, { status: 400 });
  }

  // RFC 5987, the same encoding the single-file route uses: the name is derived
  // from user text and must never be able to inject a header.
  const filename = encodeURIComponent(`${name}.zip`).replace(/['()*]/g, escape);
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function stamp(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
}

export async function POST(req: Request): Promise<NextResponse> {
  const form = await req.formData();
  const ids = form.getAll("id").map(String).filter(Boolean);
  return archive(ids, `files-${stamp()}`);
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const bundleId = url.searchParams.get("bundle");
  if (!bundleId) {
    return NextResponse.json(
      { error: "Geef een bundel op om te downloaden" }, { status: 400 });
  }
  let bundle: { documentIds: string[]; name: string };
  try {
    const caller = await serverCaller(); // protectedProcedure rejects the unauthenticated
    bundle = await caller.bundles.get({ id: bundleId });
  } catch (e) {
    const mapped = mapTrpcError(e, "Onbekende bundel");
    if (mapped) return mapped;
    throw e;
  }
  return archive(bundle.documentIds, bundle.name);
}
