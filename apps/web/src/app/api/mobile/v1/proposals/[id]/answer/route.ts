import { NextResponse } from "next/server";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { fail, readJsonObject, trpcErrorResponse } from "@/lib/mobile-json";

/**
 * Martin answers a question: `{revision, option}` or `{revision, freeText}`.
 * The option runs through its existing ledgered procedure. Plan 3's
 * notification answer actions use this same endpoint.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if ((await getSessionUserId()) === null) return fail("unauthorized", 401);
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;
  // Only the two fields an answer has: the input schema is strict, and a body
  // carrying both is refused rather than one of them silently winning.
  const input: Record<string, unknown> = { id, revision: body.revision };
  if ("option" in body) input.option = body.option;
  if ("freeText" in body) input.freeText = body.freeText;
  try {
    const caller = await serverCaller();
    return NextResponse.json(await caller.proposals.answer(input as never));
  } catch (e) {
    return trpcErrorResponse(e);
  }
}
