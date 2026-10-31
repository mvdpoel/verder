import { NextResponse } from "next/server";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { fail, trpcErrorResponse } from "@/lib/mobile-json";

/**
 * Creates the proposal's proposed task — only on Martin's tap. A second tap
 * returns the same task (`created: false`). Takes no body.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if ((await getSessionUserId()) === null) return fail("unauthorized", 401);
  const { id } = await params;
  try {
    const caller = await serverCaller();
    return NextResponse.json(await caller.proposals.createProposedTask({ id }));
  } catch (e) {
    return trpcErrorResponse(e);
  }
}
