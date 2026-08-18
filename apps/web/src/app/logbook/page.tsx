import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";

export default async function LogbookPage() {
  const caller = await serverCaller();
  const entries = await caller.entries.list({ limit: 100 });
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Logbook</h1>
        <Link href="/logbook/new" className="rounded bg-slate-900 text-white px-4 py-2">+ Log a contact moment</Link>
      </div>
      {entries.length === 0 && <p>Nothing logged yet — your first entry is one click away. 💪</p>}
      <ul className="space-y-3">
        {entries.map((e) => (
          <li key={e.id} className="rounded border bg-white p-4">
            <Link href={`/logbook/${e.id}`} className="font-medium hover:underline">{e.summary}</Link>
            <p className="text-sm text-slate-500">
              {e.channel} · {e.direction} · {new Date(e.occurredAt).toLocaleString("nl-NL")}
              {e.supersedesId && " · correction"}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
