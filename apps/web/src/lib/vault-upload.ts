import { NextResponse } from "next/server";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limit";

/**
 * Read a multipart body, guarded against size, WITHOUT requiring a file (the
 * phone's voice quick-log carries its recording only when Martin kept it).
 *
 * Call it only AFTER the session is validated: middleware checks cookie
 * presence only, so the session must be proven before any uploaded bytes are
 * read.
 */
export async function readGuardedForm(req: Request): Promise<FormData | NextResponse> {
  // Size guard BEFORE parsing: formData()/arrayBuffer() buffer the entire
  // body in memory, so oversized requests must be rejected up front.
  const lengthHeader = req.headers.get("content-length");
  const contentLength = lengthHeader === null ? NaN : Number(lengthHeader);
  if (!Number.isFinite(contentLength))
    return NextResponse.json({ error: "length required" }, { status: 411 });
  if (contentLength > MAX_UPLOAD_BYTES)
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  return req.formData();
}

/**
 * A file field of an already-guarded form, buffered: null when absent, a 413
 * when it is larger than the upload limit. content-length is client-controlled,
 * so the actual file size is re-checked before buffering it.
 */
export async function readFormFile(
  form: FormData, field: string,
): Promise<{ file: File; buf: Buffer } | null | NextResponse> {
  const file = form.get(field);
  if (!(file instanceof File)) return null;
  if (file.size > MAX_UPLOAD_BYTES)
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  return { file, buf: Buffer.from(await file.arrayBuffer()) };
}

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
  const form = await readGuardedForm(req);
  if (form instanceof NextResponse) return form;
  const read = await readFormFile(form, "file");
  if (read === null) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (read instanceof NextResponse) return read;
  return { ...read, form };
}
