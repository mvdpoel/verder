import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { storeFile } from "@verder/api/src/storage";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limit";

// Statement upload, vault-first: identical guards to /api/upload (auth before
// body, size before buffering), then the bytes go into the vault and
// registry.import.ingest parses them into transactions.
export async function POST(req: Request) {
  // Auth BEFORE touching the body: middleware only checks cookie presence,
  // so the session must be validated here before any uploaded bytes reach
  // the vault.
  const userId = await getSessionUserId();
  if (userId === null)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Size guard BEFORE parsing: formData()/arrayBuffer() buffer the entire
  // body in memory, so oversized requests must be rejected up front.
  const lengthHeader = req.headers.get("content-length");
  const contentLength = lengthHeader === null ? NaN : Number(lengthHeader);
  if (!Number.isFinite(contentLength))
    return NextResponse.json({ error: "length required" }, { status: 411 });
  if (contentLength > MAX_UPLOAD_BYTES)
    return NextResponse.json({ error: "file too large" }, { status: 413 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  // Belt-and-braces: content-length is client-controlled, re-check the
  // actual file size before buffering it.
  if (file.size > MAX_UPLOAD_BYTES)
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const caller = await serverCaller();
    const { sha256 } = await storeFile(process.env.VAULT_DIR ?? "./vault-files", buf);
    const summary = await caller.registry.import.ingest({ sha256, filename: file.name });
    return NextResponse.json(summary);
  } catch (e) {
    if (e instanceof TRPCError && e.code === "UNAUTHORIZED")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    // Unrecognized format and similar: the file is safely in the vault; tell
    // the user what went wrong instead of a blank 500.
    if (e instanceof TRPCError && e.code === "BAD_REQUEST")
      return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
