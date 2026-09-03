import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { readFilePath } from "@verder/api/src/storage";
import { effectiveMime } from "@verder/parsers";
import { serverCaller } from "@/lib/trpc-server";
import { servesInline } from "@/components/preview-kind";

/** RFC 9110 token/token, the only shape a Content-Type may have here. */
const SAFE_MIME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * The stored mime is sender-supplied text that nothing validates at ingest.
 * A bare CR or LF in it makes the Headers constructor throw — inside the try,
 * where only TRPCError is handled — so that document could never be viewed or
 * downloaded again. Header INJECTION is impossible either way (the constructor
 * refuses), but bricking a document is not acceptable either. Parameters are
 * dropped: the base type is all any preview decision uses.
 */
function safeMime(mime: string): string {
  const base = mime.split(";", 1)[0].trim();
  return SAFE_MIME.test(base) ? base : "application/octet-stream";
}

export async function GET(_req: Request, { params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params;
  try {
    const caller = await serverCaller(); // protectedProcedure rejects unauthenticated calls
    const doc = await caller.documents.bySha({ sha256 });
    // 410, not 404. The document exists and the app knows exactly what happened
    // to it — the bytes were destroyed on purpose and there is a ledgered
    // record saying so. Reading the file here would ENOENT into a 500.
    if (doc.purge) return NextResponse.json({ error: "purged" }, { status: 410 });
    const buf = await readFile(readFilePath(process.env.VAULT_DIR ?? "./vault-files", sha256));
    // The stored mime is whatever the source claimed. When it says nothing,
    // the bytes decide — otherwise a spreadsheet recorded as octet-stream is
    // downloaded by the browser no matter what the page wanted to do with it.
    const mime = safeMime(effectiveMime(doc.mime, buf));
    // RFC 5987 encoding: a title is user-controlled text and must never be
    // able to inject a header or break out of the quoted filename. The
    // EFFECTIVE title, because Content-Disposition beats the <a download>
    // attribute — using the evidence row's title would undo every rename.
    const filename = encodeURIComponent(doc.effectiveTitle).replace(/['()*]/g, escape);
    // Only what this app renders itself is served inline. The mime came from
    // the sender; an SVG or an HTML attachment rendered on our origin runs
    // script with the session. nosniff stops the browser guessing past that.
    const disposition = servesInline(mime) ? "inline" : "attachment";
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `${disposition}; filename*=UTF-8''${filename}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof TRPCError) {
      if (e.code === "UNAUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      if (e.code === "NOT_FOUND" || e.code === "BAD_REQUEST")
        return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw e;
  }
}
