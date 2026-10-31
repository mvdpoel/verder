import { NextResponse } from "next/server";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { fail, readJsonObject, trpcErrorResponse } from "@/lib/mobile-json";

/** Martin rejects the draft: `{reason?}`. The model's output is kept. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if ((await getSessionUserId()) === null) return fail("unauthorized", 401);
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;
  try {
    const caller = await serverCaller();
    return NextResponse.json(await caller.proposals.reject({
      id, reason: body.reason === undefined || body.reason === null ? undefined : body.reason as string }));
  } catch (e) {
    return trpcErrorResponse(e);
  }
}
