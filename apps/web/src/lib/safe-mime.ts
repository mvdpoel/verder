/** RFC 9110 token/token, the only shape a Content-Type may have here. */
const SAFE_MIME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * The stored mime is sender-supplied text that nothing validates at ingest.
 * A bare CR or LF in it makes the Headers constructor throw — inside the try,
 * where only TRPCError is handled — so that document could never be viewed or
 * downloaded again. Header INJECTION is impossible either way (the constructor
 * refuses), but bricking a document is not acceptable either. Parameters are
 * dropped: the base type is all any preview decision uses.
 *
 * Shared by the web file route and the phone's (`/api/mobile/v1/documents/
 * [id]/file`), which serve the same bytes under the same rules. Lives in lib
 * because a Next route file may export only route fields.
 */
export function safeMime(mime: string): string {
  const base = mime.split(";", 1)[0].trim();
  return SAFE_MIME.test(base) ? base : "application/octet-stream";
}

/**
 * RFC 5987 `filename*` value: a title is user-controlled text and must never
 * be able to inject a header or break out of the quoted filename.
 */
export function rfc5987(title: string): string {
  return encodeURIComponent(title).replace(/['()*]/g, escape);
}
