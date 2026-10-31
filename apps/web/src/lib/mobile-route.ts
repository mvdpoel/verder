import { NextResponse } from "next/server";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { fail, trpcErrorResponse } from "@/lib/mobile-json";

/**
 * The shape every NEW phone read route shares (Plan 3). It sits on Plan 2's
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
