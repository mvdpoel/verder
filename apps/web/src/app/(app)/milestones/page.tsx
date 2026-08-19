import { serverCaller } from "@/lib/trpc-server";
import { AddMilestoneForm, MilestoneRowEditor } from "@/components/milestone-editor";
import { STAGE_LABEL } from "@/components/wsnp-timeline";

// Single maintenance screen for the WSNP milestone timeline: stages in fixed
// order, rows inline-editable. No detail pages — milestones are a display aid.

export default async function MilestonesPage() {
  const caller = await serverCaller();
  const groups = await caller.milestones.list();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Milestones</h1>
        <p className="text-slate-600 mt-1">
          The road map of the whole process, step by step. Tick things off as they
          happen — the dashboard timeline follows along.
        </p>
      </div>
      {groups.map(({ stage, milestones }) => (
        <section key={stage}>
          <h2 className="font-semibold mb-2">{STAGE_LABEL[stage] ?? stage}</h2>
          {milestones.length === 0 && (
            <p className="text-sm text-slate-500">Nothing planned here yet — add a milestone when this stage takes shape.</p>
          )}
          <ul className="space-y-2">
            {milestones.map((m) => <MilestoneRowEditor key={m.id} milestone={m} />)}
          </ul>
          <AddMilestoneForm stage={stage} />
        </section>
      ))}
    </div>
  );
}
