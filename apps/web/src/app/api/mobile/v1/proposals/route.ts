import { NextResponse } from "next/server";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { fail, trpcErrorResponse } from "@/lib/mobile-json";

/** The phone's proposal list: pending, plus sends in flight and recent failures. */
export async function GET() {
  if ((await getSessionUserId()) === null) return fail("unauthorized", 401);
  try {
    const caller = await serverCaller();
    return NextResponse.json({ proposals: await caller.proposals.list() });
  } catch (e) {
    return trpcErrorResponse(e);
  }
}
