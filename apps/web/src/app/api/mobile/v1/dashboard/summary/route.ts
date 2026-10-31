import { mobileGet } from "@/lib/mobile-route";
import { toDashboardSummaryDTO } from "@/lib/mobile-dto";

/**
 * The map's headline, the waiting count and the task tiles. The headline reads
 * `tracks.map` — the same call the web dashboard makes — so both name the stop
 * the map draws as current; the count is `inbox.count`, the one definition.
 */
export const GET = mobileGet(async (caller) => {
  const [{ map }, stats, waitingCount] = await Promise.all([
    caller.tracks.map(), caller.tasks.stats(), caller.inbox.count(),
  ]);
  return toDashboardSummaryDTO({ map, stats, waitingCount });
});
