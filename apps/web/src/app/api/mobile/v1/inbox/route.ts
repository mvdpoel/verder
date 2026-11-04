import { mobileGet } from "@/lib/mobile-route";
import { toInboxDTO } from "@/lib/mobile-dto";

/**
 * Everything waiting on Martin, ranked (spec §7.2, §12.9): the one definition
 * in packages/api/src/waiting.ts. `count` is the list's own length.
 * `doneByGrip` is the last week of what Grip did on its own (spec §6.6),
 * each with its one-tap undo state; it never counts toward `count`.
 */
export const GET = mobileGet(async (caller) => {
  const [items, done] = await Promise.all([
    caller.inbox.list(), caller.gripActions.list({ sinceDays: 7 })]);
  return toInboxDTO(items, done);
});
