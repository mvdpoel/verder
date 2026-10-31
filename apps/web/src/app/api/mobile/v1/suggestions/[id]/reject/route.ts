import { z } from "zod";
import { mobilePost } from "@/lib/mobile-route";

/** Strict: the path names the suggestion, the body may only say why. */
const rejectBody = z.object({ reason: z.string().max(2000).optional() }).strict();

/**
 * Martin turns a suggestion down, optionally saying why (the reason is kept on
 * the verdict and feeds learning). A verdict already given stands: 409.
 */
export const POST = mobilePost(async (caller, body, { id }) => {
  const { reason } = rejectBody.parse(body);
  await caller.suggestions.reject({ id, reason });
  return { ok: true };
});
