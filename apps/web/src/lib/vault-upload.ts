import { NextResponse } from "next/server";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limit";

/**
 * Read the multipart body of an upload, guarded against size.
 *
 * Call it only AFTER the session is validated: middleware checks cookie
 * presence only, so the session must be proven before any uploaded bytes are
 * read. Returns the parsed form too, so a route can read its other fields.
 */
export async function readGuardedFile(
  req: Request,
): Promise<{ file: File; buf: Buffer; form: FormData } | NextResponse> {
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
  return { file, buf, form };
}
