import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import { getSessionIdentity, serverCaller } from "@/lib/trpc-server";
import { MAX_REGISTER_BODY_BYTES } from "@/lib/upload-limit";

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/**
 * Reads at most `limit` bytes of the body. Content-Length is not trusted (it
 * can be absent or wrong), so the stream itself is counted and abandoned the
 * moment it passes the limit.
 */
async function readBounded(req: Request, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * The phone registers its APNs token here. The session is validated BEFORE
 * the body is touched, as every mobile route does (spec §6.1). The device is
 * bound to the session it registered under, taken from the validated cookie:
 * a `sessionId` in the body is ignored, or a client could tie its pushes to a
 * session that a lost-phone revoke would not end.
 */
export async function POST(req: Request) {
  const identity = await getSessionIdentity();
  if (identity === null) return fail("unauthorized", 401);

  const text = await readBounded(req, MAX_REGISTER_BODY_BYTES);
  if (text === null) return fail("body too large", 413);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail("body must be JSON", 400); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return fail("body must be a JSON object", 400);
  const b = parsed as Record<string, unknown>;

  try {
    const caller = await serverCaller();
    const { id } = await caller.push.registerDevice({
      token: b.token as string, environment: b.environment as "development" | "production",
      bundleId: b.bundleId as "pro.vanderpoel.verder", appVersion: b.appVersion as string,
      sessionId: identity.sessionId,
    });
    return NextResponse.json({ id });
  } catch (e) {
    if (e instanceof TRPCError && e.code === "UNAUTHORIZED") return fail("unauthorized", 401);
    if (e instanceof TRPCError && e.code === "BAD_REQUEST") return fail("invalid input", 400);
    throw e;
  }
}
