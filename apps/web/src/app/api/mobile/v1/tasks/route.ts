import { mobileGet } from "@/lib/mobile-route";
import { fail } from "@/lib/mobile-json";
import { toTaskDTO } from "@/lib/mobile-dto";

const FILTERS = ["open", "waiting", "done"] as const;
type Filter = (typeof FILTERS)[number];

/**
 * Tasks with their effective status (ledger seq, never the raw column) and the
 * statuses each may move to, so the phone offers only legal transitions.
 * `?filter=open|waiting|done`; no filter lists every task.
 */
export const GET = mobileGet(async (caller, req) => {
  const raw = new URL(req.url).searchParams.get("filter");
  if (raw !== null && !(FILTERS as readonly string[]).includes(raw))
    return fail("filter must be open, waiting or done", 400);
  const tasks = await caller.tasks.list({ filter: (raw ?? undefined) as Filter | undefined });
  // validNext is a pure function of the status: ask once per distinct status.
  const statuses = [...new Set(tasks.map((t) => t.effectiveStatus))];
  const next = new Map(await Promise.all(statuses.map(async (from) =>
    [from, await caller.tasks.validNext({ from })] as const)));
  return tasks.map((t) => toTaskDTO(t, next.get(t.effectiveStatus) ?? []));
});
