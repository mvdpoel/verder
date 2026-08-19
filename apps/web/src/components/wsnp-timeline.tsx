import Link from "next/link";

// Presentational (server-safe) WSNP timeline strip for the dashboard.
// Renders milestones.timeline() output — the derivation itself is pure and
// lives in @verder/api (wsnp-timeline.ts); this file only draws it.

export const STAGE_LABEL: Record<string, string> = {
  application: "Application",
  accepted: "Accepted",
  onboarding: "Onboarding",
  "wsnp-start": "WSNP start",
  settlement: "Settlement",
  "clean-slate": "Clean slate",
};

export type TimelineMilestoneView = {
  id: string;
  title: string;
  done: boolean;
  happenedAt: Date | null;
  expectedAt: Date | null;
};

export type TimelineStageView = {
  stage: string;
  state: "done" | "current" | "future" | "empty";
  milestones: TimelineMilestoneView[];
};

export type TimelineCountdownView = { endsAt: Date; daysLeft: number };

const NODE_CLASS: Record<TimelineStageView["state"], string> = {
  done: "bg-green-600 border-green-600 text-white",
  current: "bg-white border-slate-900 ring-2 ring-slate-300 text-slate-900",
  future: "bg-slate-100 border-slate-200 text-slate-400",
  empty: "bg-white border-dashed border-slate-300 text-slate-300",
};

const LABEL_CLASS: Record<TimelineStageView["state"], string> = {
  done: "text-green-700",
  current: "font-semibold text-slate-900",
  future: "text-slate-400",
  empty: "text-slate-400",
};

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("nl-NL");
}

/** Best date to show for a milestone dot: what happened, else what's expected. */
function dotDate(m: TimelineMilestoneView): string | null {
  if (m.happenedAt) return formatDate(m.happenedAt);
  if (m.expectedAt) return `expected ${formatDate(m.expectedAt)}`;
  return null;
}

/**
 * Six-stage strip, left to right: done (green check), current (accent ring),
 * future (muted), empty (dashed). Milestone dots with dates under the current
 * stage; countdown chip once a done wsnp-start milestone sets the clock.
 * The whole strip links to /milestones for maintenance.
 */
export function WsnpTimeline({ stages, countdown }: {
  stages: TimelineStageView[];
  countdown: TimelineCountdownView | null;
}) {
  const current = stages.find((s) => s.state === "current") ?? null;
  return (
    <Link href="/milestones" className="block rounded border bg-white p-4 hover:bg-slate-50">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">The road to a clean slate</h2>
        {countdown && (
          <span className="rounded-full bg-blue-100 text-blue-800 px-3 py-1 text-xs font-medium">
            WSNP: {countdown.daysLeft} days left · ends {formatDate(countdown.endsAt)}
          </span>
        )}
      </div>
      <div className="flex items-center">
        {stages.map((s, idx) => (
          <div key={s.stage} className={`flex items-center ${idx > 0 ? "flex-1" : ""}`}>
            {idx > 0 && <div className={`h-px flex-1 mx-2 ${s.state === "done" ? "bg-green-600" : "bg-slate-200"}`} />}
            <div className="flex flex-col items-center gap-1">
              <span className={`flex h-8 w-8 items-center justify-center rounded-full border text-sm ${NODE_CLASS[s.state]}`}>
                {s.state === "done" ? "✓" : idx + 1}
              </span>
              <span className={`text-xs whitespace-nowrap ${LABEL_CLASS[s.state]}`}>
                {STAGE_LABEL[s.stage] ?? s.stage}
              </span>
            </div>
          </div>
        ))}
      </div>
      {current && current.milestones.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
          {current.milestones.map((m) => (
            <li key={m.id} className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${m.done ? "bg-green-600" : "bg-slate-300"}`} />
              <span className={m.done ? "text-green-700" : ""}>{m.title}</span>
              {dotDate(m) && <span className="text-slate-400">· {dotDate(m)}</span>}
            </li>
          ))}
        </ul>
      )}
    </Link>
  );
}
