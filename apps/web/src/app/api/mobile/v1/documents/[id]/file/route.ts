import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { readFilePath } from "@verder/api/src/storage";
import { effectiveMime } from "@verder/parsers";
import { mobileGet } from "@/lib/mobile-route";
import { fail } from "@/lib/mobile-json";
import { rfc5987, safeMime } from "@/lib/safe-mime";
import { servesInline } from "@/components/preview-kind";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A document's bytes for the pocket dossier, under the same rules as the web's
 * `/api/files/[sha256]` (safe mime, the EFFECTIVE title, nosniff). It sits
 * under /api/mobile so a missing cookie answers JSON 401 and never a 307 to
 * /login that a client could read as the file.
 *
 * 410 for a purged document — it existed and was destroyed on purpose, so the
 * phone deletes its copy — and 404 for a discarded one: the phone holds no
 * discarded document, and its bytes are not served to it.
 */
export const GET = mobileGet(async (caller, _req, params) => {
  const id = params.id ?? "";
  if (!UUID.test(id)) return fail("not found", 404);
  const doc = await caller.documents.get({ id });
  if (doc.purge) return fail("purged", 410);
  if (doc.effectiveStatus === "discarded") return fail("not found", 404);
  let buf: Buffer;
  try {
    buf = await readFile(readFilePath(process.env.VAULT_DIR ?? "./vault-files", doc.sha256));
  } catch {
    // A row whose bytes are missing is an orphan the phone cannot fix; /verify
    // reports it. Never a 500 the phone would retry forever.
    return fail("file is not in the vault", 404);
  }
  const mime = safeMime(effectiveMime(doc.mime, buf));
  const disposition = servesInline(mime) ? "inline" : "attachment";
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${disposition}; filename*=UTF-8''${rfc5987(doc.effectiveTitle)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
