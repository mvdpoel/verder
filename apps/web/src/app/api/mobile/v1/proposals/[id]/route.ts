import { NextResponse } from "next/server";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { fail, trpcErrorResponse } from "@/lib/mobile-json";

/** One proposal, with everything the approve screen shows. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if ((await getSessionUserId()) === null) return fail("unauthorized", 401);
  const { id } = await params;
  try {
    const caller = await serverCaller();
    return NextResponse.json(await caller.proposals.get({ id }));
  } catch (e) {
    return trpcErrorResponse(e);
  }
}
