import { mobilePost } from "@/lib/mobile-route";

/** "Laat maar": the question leaves Voor jou and stands under Eerdere vragen; a
 *  pending proposal it drafted is released as a row of its own. Idempotent. */
export const POST = mobilePost(async (caller, _body, { id }) => {
  const r = await caller.requests.dismiss({ id });
  return { id: r.id, status: r.status, dismissedAt: r.dismissedAt ? new Date(r.dismissedAt).toISOString() : null };
});
