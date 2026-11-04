import { z } from "zod";
import { mobilePost } from "@/lib/mobile-route";

/** Strict and empty: the path names the change, and an undo takes no options. */
const undoBody = z.object({}).strict();

/**
 * One tap undoes one thing verder did on its own (spec §6.6, Plan 3 Task 15).
 *
 * NO FACE ID, deliberately: an undo reveals nothing and sends nothing — it
 * appends a correction in Martin's name restoring what the document was before
 * verder touched it. 409 when something changed since ("al aangepast", which
 * is also a second tap) or the document was destroyed ("vernietigd"); 400 for
 * an auto-name, whose name also lives on the NAS share.
 */
export const POST = mobilePost(async (caller, body, { changeId }) => {
  undoBody.parse(body);
  const out = await caller.gripActions.undo({ changeId });
  return { ok: true, documentId: out.documentId };
});
