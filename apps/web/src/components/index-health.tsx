import type { IndexHealth } from "@verder/api/src/search/health";
import { indexHealthState } from "@/lib/index-health-state";

// Server-safe card. Sits beside the ledger checks on /verify so a stalled index
// is as visible as a broken chain — with the difference spelled out: the index
// is derived and rebuildable, the chain is the evidence.

const TONE_ICON: Record<string, string> = { ok: "🟢", warn: "🟡", bad: "🔴" };
const TONE_TEXT: Record<string, string> = {
  ok: "text-emerald-700", warn: "text-amber-700", bad: "text-red-700",
};

export function IndexHealthCard({ health, now }: { health: IndexHealth; now: number }) {
  const state = indexHealthState(health, now);
  return (
    <div className="rounded border bg-white p-6 space-y-3">
      <h2 className="font-semibold">Search index</h2>
      <p className="text-sm text-slate-600">
        The index is derived, never evidence: it can be rebuilt from the record at any
        time (<code>pnpm --filter worker reindex</code>). A broken index can only fail
        to find something — it can never change what happened.
      </p>
      <p className={TONE_TEXT[state.tone]}>{TONE_ICON[state.tone]} {state.message}</p>
      <ul className="text-sm space-y-1 text-slate-600">
        <li>{health.chunks} chunks indexed</li>
        <li>{health.embedFailures} chunks waiting on a retry after a failed embedding</li>
        <li>{health.outboxDepth} records waiting in the queue</li>
        <li>
          Last index run:{" "}
          {health.lastDrainAt
            ? new Date(health.lastDrainAt).toLocaleString("nl-NL")
            : "never"}
        </li>
      </ul>
    </div>
  );
}
