import { mobilePost } from "@/lib/mobile-route";

/** Martin opened the answer: it stops waiting on him (badge, widget, Voor jou). Idempotent. */
export const POST = mobilePost(async (caller, _body, { id }) => {
  const r = await caller.requests.markOpened({ id });
  return { id: r.id, openedAt: new Date(r.openedAt as Date | string).toISOString() };
});
