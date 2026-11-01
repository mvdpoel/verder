import { mobileGet } from "@/lib/mobile-route";
import { fail } from "@/lib/mobile-json";

/**
 * The Sunday summary screen (Plan 3 Task 26, spec §7.9): the newest summary
 * the worker composed and pushed, exactly as stored — `WeeklySummary` in
 * packages/api/src/weekly-summary.ts is the contract. 404 before the first
 * Sunday, which the phone renders as "nog geen weekoverzicht".
 */
export const GET = mobileGet(async (caller) => {
  const summary = await caller.dashboard.weekly();
  return summary ?? fail("no weekly summary yet", 404);
});
