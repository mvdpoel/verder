import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { storeFile } from "@verder/api/src/storage";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";

export async function POST(req: Request) {
  // Auth BEFORE touching the body: middleware only checks cookie presence,
  // so the session must be validated here before any uploaded bytes reach
  // the vault. registerUpload's protectedProcedure alone is too late — the
  // file would already be on disk.
  const userId = await getSessionUserId();
  if (userId === null)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
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
