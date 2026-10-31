import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";

/**
 * Shared plumbing for the phone's JSON routes under /api/mobile/v1. Lives in
 * lib because a Next route file may export only route fields.
 */

/** A proposal edit is a mail body plus a few short fields; 256 KB is generous. */
export const MAX_MOBILE_JSON_BYTES = 256 * 1024;

export const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/**
 * Reads at most `limit` bytes of the body and parses it as a JSON object.
 * Content-Length is not trusted (it can be absent or wrong), so the stream
 * itself is counted and abandoned the moment it passes the limit. An empty
 * body reads as `{}`, so a POST with nothing to say needs no body at all.
 */
export async function readJsonObject(
  req: Request, limit = MAX_MOBILE_JSON_BYTES,
): Promise<Record<string, unknown> | NextResponse> {
  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); return fail("body too large", 413); }
      chunks.push(value);
    }
    text = new TextDecoder().decode(Buffer.concat(chunks));
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail("body must be JSON", 400); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return fail("body must be a JSON object", 400);
  return parsed as Record<string, unknown>;
}

const STATUS: Partial<Record<TRPCError["code"], number>> = {
  UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, BAD_REQUEST: 400,
};

/** A TRPCError as the phone sees it; anything else is rethrown (a 500). */
export function trpcErrorResponse(e: unknown): NextResponse {
  if (e instanceof TRPCError && STATUS[e.code] !== undefined) {
    const status = STATUS[e.code]!;
    // The message of a 400/409 says WHICH check refused (a recipient, a stale
    // revision); it names ids and never secrets, and the phone shows it.
    const error = status === 401 ? "unauthorized" : status === 404 ? "not found" : e.message;
    return fail(error, status);
  }
  throw e;
}
