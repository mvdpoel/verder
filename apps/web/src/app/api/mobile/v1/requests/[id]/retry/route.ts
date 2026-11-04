import { z } from "zod";
import { mobilePost } from "@/lib/mobile-route";

const body = z.object({ clientId: z.string().uuid() }).strict();

/** "Opnieuw proberen": the same question as a NEW request, idempotent on the
 *  phone's `clientId`; the failed one is put away. */
export const POST = mobilePost(async (caller, raw, { id }) => {
  const b = body.parse(raw);
  return caller.requests.retry({ id, clientId: b.clientId });
});
