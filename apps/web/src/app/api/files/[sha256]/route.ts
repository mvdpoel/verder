import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { readFilePath } from "@verder/api/src/storage";
import { sniffContainer, UNINFORMATIVE_MIMES } from "@verder/parsers";
import { serverCaller } from "@/lib/trpc-server";

export async function GET(_req: Request, { params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params;
  try {
    const caller = await serverCaller(); // protectedProcedure rejects unauthenticated calls
    const doc = await caller.documents.bySha({ sha256 });
    const buf = await readFile(readFilePath(process.env.VAULT_DIR ?? "./vault-files", sha256));
    // The stored mime is whatever the source claimed. When it says nothing,
    // the bytes decide — otherwise a spreadsheet recorded as octet-stream is
    // downloaded by the browser no matter what the page wanted to do with it.
    const mime = UNINFORMATIVE_MIMES.has(doc.mime) ? (sniffContainer(buf) ?? doc.mime) : doc.mime;
    // RFC 5987 encoding: a title is user-controlled text and must never be
    // able to inject a header or break out of the quoted filename.
    const filename = encodeURIComponent(doc.title).replace(/['()*]/g, escape);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `inline; filename*=UTF-8''${filename}`,
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
