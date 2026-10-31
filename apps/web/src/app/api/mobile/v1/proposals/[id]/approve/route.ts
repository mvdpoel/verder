import { NextResponse } from "next/server";
import { getSessionUserId, serverCaller } from "@/lib/trpc-server";
import { fail, readJsonObject, trpcErrorResponse } from "@/lib/mobile-json";

/**
 * Martin approves the final text: `{revision, payload: {to, cc, subject, body,
 * attachmentDocumentIds, entrySummary}}`. Nothing is sent here; the send job
 * claims the approved proposal. Face ID is the phone's gate — the server sees
 * the session and the revision only (Plan 2, "Not grounded in code").
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Auth BEFORE touching the body, as every mobile route does (spec §6.1).
  if ((await getSessionUserId()) === null) return fail("unauthorized", 401);
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const { id } = await params;
  try {
    const caller = await serverCaller();
    return NextResponse.json(await caller.proposals.approve({
      id, revision: body.revision as number, payload: body.payload as never }));
  } catch (e) {
    return trpcErrorResponse(e);
  }
}
