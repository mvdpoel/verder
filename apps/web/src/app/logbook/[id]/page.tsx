import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const e = await caller.entries.get({ id });
  const parties = await caller.parties.list();
  const nameOf = (pid: string) => parties.find((p) => p.id === pid)?.name ?? pid;
  return (
    <article className="max-w-2xl space-y-4">
      {e.supersededBy && (
        <p className="rounded bg-amber-50 border border-amber-300 p-3 text-sm">
          This entry was corrected — see <Link className="underline" href={`/logbook/${e.supersededBy}`}>the correction</Link>. Both stay on record; that&apos;s what makes your log credible.
        </p>
      )}
      <h1 className="text-2xl font-bold">{e.summary}</h1>
      <p className="text-sm text-slate-500">
        {e.channel} · {e.direction} · happened {new Date(e.occurredAt).toLocaleString("nl-NL")} · logged {new Date(e.recordedAt).toLocaleString("nl-NL")} · source: {e.source}
      </p>
      {e.details && <p className="whitespace-pre-wrap">{e.details}</p>}
      <section>
        <h2 className="font-semibold">Who was involved</h2>
        <ul className="list-disc ml-5">{e.participants.map((p) => <li key={p.partyId}>{nameOf(p.partyId)}</li>)}</ul>
      </section>
      <section>
        <h2 className="font-semibold">Agreed actions</h2>
        <ul className="list-disc ml-5">
          {e.actionItems.map((a) => (
            <li key={a.id}>{a.description} <span className="text-xs text-slate-500">({a.clarity}{a.dueAt ? `, due ${new Date(a.dueAt).toLocaleDateString("nl-NL")}` : ""})</span></li>
          ))}
        </ul>
      </section>
      {!e.supersededBy && (
        <Link href={`/logbook/new?correct=${e.id}`} className="inline-block rounded border px-4 py-2">Correct this entry</Link>
      )}
    </article>
  );
}
