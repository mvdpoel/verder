import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { storeFile } from "@verder/api/src/storage";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { fail, trpcErrorResponse } from "@/lib/mobile-json";
import { readFormFile, readGuardedForm } from "@/lib/vault-upload";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Date-only or date-time with an offset; Date.parse alone accepts free text.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;
const CHANNELS = ["call", "meeting", "email", "whatsapp", "voicemail", "letter", "other"] as const;
type Channel = (typeof CHANNELS)[number];
/** The same bound `suggestions.createVoice` enforces, checked before any write. */
const TRANSCRIPT_MAX = 20_000;

const bad = (error: string) => noStore(fail(error, 400));
function noStore(res: NextResponse): NextResponse {
  res.headers.set("cache-control", "no-store");
  return res;
}

/**
 * The phone's voice quick-log (Plan 3 Task 24, spec §8): a call Martin
 * dictated, transcribed ON the phone, arrives as a PENDING log-entry
 * suggestion. It never writes an entry — he approves it in Voor jou — so
 * without a recording nothing here reaches the ledger at all.
 *
 * Multipart: `clientId`, `occurredAt`, `partyId`, `channel` (default `call`),
 * `transcript`, and `audio` only when he tapped "bewaar opname". A kept
 * recording is stored as `phone-voice` under `sourceRef = phone:<clientId>`
 * and looked up by that ref BEFORE anything is written, so a retry after a
 * lost response stores it once; the suggestion is idempotent on the same
 * clientId. The party is checked BEFORE the audio is stored, because a stored
 * recording is a ledgered `document.ingested` and can never be taken back.
 */
export async function POST(req: Request) {
  // Auth BEFORE touching the body, exactly as the document upload does.
  if ((await getSessionUserId()) === null) return noStore(fail("unauthorized", 401));

  const form = await readGuardedForm(req);
  if (form instanceof NextResponse) return noStore(form);

  const clientId = form.get("clientId");
  if (typeof clientId !== "string" || !UUID_V4.test(clientId))
    return bad("clientId must be a UUID");
  const occurredRaw = form.get("occurredAt");
  const occurredAt = typeof occurredRaw === "string" && ISO_8601.test(occurredRaw)
    ? new Date(occurredRaw) : null;
  if (occurredAt === null || Number.isNaN(occurredAt.getTime()))
    return bad("occurredAt must be an ISO 8601 date");
  const partyId = form.get("partyId");
  if (typeof partyId !== "string" || !UUID.test(partyId)) return bad("partyId must be a UUID");
  const channelRaw = form.get("channel") ?? "call";
  if (typeof channelRaw !== "string" || !(CHANNELS as readonly string[]).includes(channelRaw))
    return bad(`channel must be one of ${CHANNELS.join(", ")}`);
  const channel = channelRaw as Channel;
  const transcriptRaw = form.get("transcript");
  const transcript = typeof transcriptRaw === "string" ? transcriptRaw.trim() : "";
  if (transcript === "") return bad("transcript must not be empty");
  if (transcript.length > TRANSCRIPT_MAX) return bad("transcript is too long");

  const audio = await readFormFile(form, "audio");
  if (audio instanceof NextResponse) return noStore(audio);
  if (audio !== null && !audio.file.type.toLowerCase().startsWith("audio/"))
    return bad("audio must be an audio file");

  const sourceRef = `phone:${clientId.toLowerCase()}`;
  try {
    const caller = await serverCaller();
    try {
      await caller.parties.get({ id: partyId });
    } catch (e) {
      if (e instanceof TRPCError && e.code === "NOT_FOUND") return bad("partyId is not a known party");
      throw e;
    }

    let audioDocumentId: string | null = null;
    if (audio !== null) {
      const existing = await caller.documents.bySourceRef({ source: "phone-voice", sourceRef });
      if (existing) {
        audioDocumentId = existing.id;
      } else {
        const { sha256 } = await storeFile(process.env.VAULT_DIR ?? "./vault-files", audio.buf);
        const doc = await caller.documents.registerUpload({
          sha256, sizeBytes: audio.buf.length, mime: audio.file.type,
          title: audio.file.name || `Gesprek ${occurredAt.toISOString().slice(0, 10)}.m4a`,
          source: "phone-voice", sourceRef, receivedAt: occurredAt });
        audioDocumentId = doc.id;
      }
    }

    const s = await caller.suggestions.createVoice({
      clientId, occurredAt, partyId, channel, transcript,
      ...(audioDocumentId ? { audioDocumentId } : {}) });
    return noStore(NextResponse.json({ suggestionId: s.id, audioDocumentId, duplicate: s.duplicate }));
  } catch (e) {
    return noStore(trpcErrorResponse(e));
  }
}
