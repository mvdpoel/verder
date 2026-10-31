import { protectedProcedure, router } from "../trpc";
import { loadWaiting } from "../waiting";

/**
 * Everything waiting on Martin, ranked (spec §7.2, §12.9). `count` is the
 * list's length and never a second SQL count, so the badge and the list it
 * opens can never disagree.
 */
export const inboxRouter = router({
  list: protectedProcedure.query(({ ctx }) => loadWaiting(ctx.db)),
  count: protectedProcedure.query(async ({ ctx }) => (await loadWaiting(ctx.db)).length),
});
