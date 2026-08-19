import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { AddTimelineEventForm, TimelineEventEditor } from "@/components/timeline-editor";
import { KIND_BADGE, KIND_LABEL } from "@/components/timeline-kinds";

// The curated story of the process: the moments that matter, newest first.
// Everything here is hand-picked by Martin — the logbook keeps the complete
// record, this is the version you'd hand someone who asks "what happened?".

export default async function TimelinePage() {
  const caller = await serverCaller();
  const events = await caller.timeline.list();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Timeline</h1>
        <p className="text-slate-600 mt-1">
          The key moments, in order. Add the ones that matter — a call, a letter,
          a decision — and link them to the logbook entry or document that proves it.
        </p>
      </div>

      <AddTimelineEventForm />

      {events.length === 0 ? (
        <p className="text-slate-500">
          No key events yet — add the moments that matter and the story builds itself.
        </p>
      ) : (
        <ol className="space-y-3">
          {events.map((e) => (
            <li key={e.id} className="rounded border bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${KIND_BADGE[e.kind] ?? KIND_BADGE.other}`}>
                  {KIND_LABEL[e.kind] ?? e.kind}
                </span>
                <span className="text-sm text-slate-500">
                  {new Date(e.happenedAt).toLocaleDateString("nl-NL")}
                </span>
                <span className="font-medium">{e.title}</span>
                <span className="ml-auto"><TimelineEventEditor event={e} /></span>
              </div>
              {e.note && <p className="mt-1 text-sm text-slate-600">{e.note}</p>}
              {(e.entry || e.document || e.milestone) && (
                <div className="mt-2 flex flex-wrap gap-3 text-sm">
                  {e.entry && (
                    <Link className="text-slate-600 hover:underline" href={`/logbook/${e.entry.id}`}>
                      → logbook: {e.entry.summary}
                    </Link>
                  )}
                  {e.document && (
                    <Link className="text-slate-600 hover:underline" href={`/vault/${e.document.id}`}>
                      → document: {e.document.title}
                    </Link>
                  )}
                  {e.milestone && (
                    <Link className="text-slate-600 hover:underline" href="/milestones">
                      → milestone: {e.milestone.title}
                    </Link>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
