import { z } from "zod";
import { mobilePost } from "@/lib/mobile-route";

const body = z.object({ index: z.number().int().min(0).max(50), done: z.boolean() }).strict();

/** Tick or untick one of "Wat jij nog moet doen" (Martin's own note about work
 *  he did outside Grip; nothing in the dossier changes). Idempotent. */
export const POST = mobilePost(async (caller, raw, { id }) => {
  const b = body.parse(raw);
  return caller.requests.step({ id, index: b.index, done: b.done });
});
