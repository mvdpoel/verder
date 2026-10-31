import { NextResponse } from "next/server";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { ZodError } from "zod";
import { fail, readJsonObject, trpcErrorResponse } from "@/lib/mobile-json";

/**
 * The shape every NEW phone route shares (Plan 3), reads and writes. It sits on Plan 2's
 * mobile-json.ts and duplicates none of it: `fail` for the auth refusal and
 * `trpcErrorResponse` as the one error map. Plan 2's own routes keep their
 * hand-written bodies; only new routes use this.
 */

export type Caller = Awaited<ReturnType<typeof serverCaller>>;

type Params = Record<string, string>;
type Handler = (caller: Caller, req: Request, params: Params) => Promise<unknown>;

/**
 * The phone's data is Martin's dossier and changes under it constantly; no
 * cache between here and the phone (the Cloudflare tunnel included) may keep
 * a copy or serve a stale one.
 */
function noStore(res: NextResponse): NextResponse {
  res.headers.set("cache-control", "no-store");
  return res;
}

/**
 * Auth FIRST: the session is validated before `serverCaller()` exists, so a
 * request without one never reaches a router. A handler may return a
 * NextResponse of its own (a 400 on a query parameter); anything else is
 * answered as JSON.
 */
export function mobileGet(handler: Handler) {
  return async (req: Request, ctx: { params: Promise<Params> }): Promise<NextResponse> => {
    if ((await getSessionUserId()) === null) return noStore(fail("unauthorized", 401));
    try {
      const params = (await ctx?.params) ?? {};
      const out = await handler(await serverCaller(), req, params);
      return noStore(out instanceof NextResponse ? out : NextResponse.json(out));
    } catch (e) {
      return noStore(trpcErrorResponse(e));
    }
  };
}

/** A phone edit is a handful of short fields, never a mail body. */
export const MAX_MOBILE_EDIT_BYTES = 64 * 1024;

type PostHandler = (
  caller: Caller, body: Record<string, unknown>, params: Params, req: Request,
) => Promise<unknown>;

/**
 * `mobileGet` for a write: auth BEFORE the body is read, so a request without
 * a session never makes the server buffer what it sent. The body goes through
 * Plan 2's `readJsonObject` (413 over the limit, 400 on anything but a JSON
 * object). A ZodError raised while the handler builds a procedure's input — an
 * unknown or wrongly typed edit — is the client's mistake and answers 400 with
 * the issues; one raised inside a procedure already arrives as BAD_REQUEST.
 */
export function mobilePost(handler: PostHandler) {
  return async (req: Request, ctx: { params: Promise<Params> }): Promise<NextResponse> => {
    if ((await getSessionUserId()) === null) return noStore(fail("unauthorized", 401));
    const body = await readJsonObject(req, MAX_MOBILE_EDIT_BYTES);
    if (body instanceof NextResponse) return noStore(body);
    try {
      const params = (await ctx?.params) ?? {};
      const out = await handler(await serverCaller(), body, params, req);
      return noStore(out instanceof NextResponse ? out : NextResponse.json(out ?? { ok: true }));
    } catch (e) {
      if (e instanceof ZodError) return noStore(fail(zodMessage(e), 400));
      return noStore(trpcErrorResponse(e));
    }
  };
}

/** `path: message` per issue: names a field, never echoes a value. */
function zodMessage(e: ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}
