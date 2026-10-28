import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { storeFile } from "@verder/api/src/storage";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { readGuardedFile } from "@/lib/vault-upload";

export async function POST(req: Request) {
  // Auth BEFORE touching the body: middleware only checks cookie presence,
  // so the session must be validated here before any uploaded bytes reach
  // the vault. registerUpload's protectedProcedure alone is too late — the
  // file would already be on disk.
  const userId = await getSessionUserId();
  if (userId === null)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const read = await readGuardedFile(req);
  if (read instanceof NextResponse) return read;
  const { file, buf } = read;
  try {
    const caller = await serverCaller();
    const { sha256 } = await storeFile(process.env.VAULT_DIR ?? "./vault-files", buf);
    const doc = await caller.documents.registerUpload({
      sha256, sizeBytes: buf.length, mime: file.type || "application/octet-stream",
      title: file.name, source: "upload", receivedAt: new Date() });
    return NextResponse.json(doc);
  } catch (e) {
    if (e instanceof TRPCError && e.code === "UNAUTHORIZED")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
