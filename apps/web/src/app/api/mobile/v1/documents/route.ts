import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { storeFile } from "@verder/api/src/storage";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { readGuardedFile } from "@/lib/vault-upload";

const PHONE_SOURCES = ["phone-scan", "phone-share"] as const;
type PhoneSource = (typeof PHONE_SOURCES)[number];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Date-only or date-time with an offset; Date.parse alone accepts free text.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/**
 * The phone's upload: one PDF per request, idempotent on the client's UUID.
 *
 * A retry after a lost response carries the same clientId, and the phone may
 * have re-encoded the PDF in between, so sha256 dedup alone would ingest it
 * twice. The clientId is stored as `sourceRef = "phone:<clientId>"` and looked
 * up BEFORE anything is written to the vault.
 */
export async function POST(req: Request) {
  // Auth BEFORE touching the body, exactly as api/upload does.
  const userId = await getSessionUserId();
  if (userId === null)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const read = await readGuardedFile(req);
  if (read instanceof NextResponse) return read;
  const { file, buf, form } = read;

  const clientId = form.get("clientId");
  if (typeof clientId !== "string" || !UUID_V4.test(clientId))
    return bad("clientId must be a UUID");
  const source = form.get("source");
  if (typeof source !== "string" || !(PHONE_SOURCES as readonly string[]).includes(source))
    return bad("source must be phone-scan or phone-share");
  const capturedAt = form.get("capturedAt");
  const receivedAt = typeof capturedAt === "string" && ISO_8601.test(capturedAt)
    ? new Date(capturedAt) : null;
  if (receivedAt === null || Number.isNaN(receivedAt.getTime()))
    return bad("capturedAt must be an ISO 8601 date");

  const sourceRef = `phone:${clientId.toLowerCase()}`;
  try {
    const caller = await serverCaller();
    const existing = await caller.documents.bySourceRef({ source: source as PhoneSource, sourceRef });
    if (existing) return NextResponse.json({ id: existing.id, duplicate: true });

    const { sha256 } = await storeFile(process.env.VAULT_DIR ?? "./vault-files", buf);
    const doc = await caller.documents.registerUpload({
      sha256, sizeBytes: buf.length, mime: file.type || "application/octet-stream",
      title: file.name || `Telefoonscan ${receivedAt.toISOString().slice(0, 10)}.pdf`,
      source: source as PhoneSource, sourceRef, receivedAt });
    // registerUpload dedups on sha256: identical bytes already in the vault
    // (mailed earlier, say) come back as THAT document, not a new one.
    return NextResponse.json({ id: doc.id, duplicate: doc.sourceRef !== sourceRef });
  } catch (e) {
    if (e instanceof TRPCError && e.code === "UNAUTHORIZED")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
