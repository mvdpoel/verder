import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { DecisionForm } from "@/components/decision-form";
import { ItemFactsForm } from "@/components/item-facts-form";
import { DecisionTimeline, StatusBadge, formatEuro } from "@/components/registry-list";

const TASK_STATUS_BADGE: Record<string, string> = {
  open: "bg-slate-100 text-slate-700",
  "in-progress": "bg-blue-100 text-blue-700",
  waiting: "bg-amber-100 text-amber-700",
};

function TaskStatusBadge({ status }: { status: string }) {
  const cls = TASK_STATUS_BADGE[status] ?? "bg-slate-100 text-slate-700";
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}

export default async function RegistryItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const item = await caller.registry.items.get({ id });
  const vaultDocs = await caller.documents.list({ limit: 100 });
  const docTitles = new Map(item.documents.map((d) => [d.id, d.title]));
  const blocker = item.decisions[0]?.blockerNote;
  const blockingTasks = item.blockingTasks;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{item.name}</h1>
        <StatusBadge status={item.effectiveStatus} kind="item" />
        <span className="text-sm text-slate-500">
          {item.category} · {formatEuro(item.amountCents)}/{item.billingCycle} · {formatEuro(item.monthlyCents)}/mo · via {item.discoveredVia}
        </span>
      </div>
      {blockingTasks.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm space-y-2">
          <p>
            {blocker
              ? <>Keep in mind: {blocker}</>
              : <>A few tasks are still in the way before this one can move — one step at a time:</>}
          </p>
          <ul className="space-y-1">
            {blockingTasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <TaskStatusBadge status={t.effectiveStatus} />
                <Link href={`/tasks/${t.id}`} className="underline">{t.title}</Link>
                {t.dueAt && (
                  <span className="text-slate-500">
                    due {new Date(t.dueAt).toLocaleDateString("nl-NL")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {blockingTasks.length === 0 && blocker && (
        <p className="rounded border border-green-300 bg-green-50 p-3 text-sm">
          Blocker cleared — ready to decide?{" "}
          <a href="#decide" className="underline">Record the next step below.</a>{" "}
          <span className="text-slate-500">(The note was: {blocker})</span>
        </p>
      )}
      <div className="grid grid-cols-2 gap-8 items-start">
        <div className="space-y-6">
          <ItemFactsForm item={{
            id: item.id, name: item.name, category: item.category,
            amountCents: item.amountCents, billingCycle: item.billingCycle,
            paymentChannel: item.paymentChannel,
            contractStart: item.contractStart, contractEnd: item.contractEnd,
            noticePeriod: item.noticePeriod, cancellationMethod: item.cancellationMethod,
            cancellationDetails: item.cancellationDetails, accountNumber: item.accountNumber,
          }} />
          <section>
            <h2 className="font-semibold mb-2">Evidence — charges from your statements</h2>
            {item.transactions.length === 0
              ? <p className="text-sm text-slate-600">No linked transactions yet.</p>
              : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-slate-500">
                    <th className="py-1 pr-3 font-normal">Date</th>
                    <th className="py-1 pr-3 font-normal">Amount</th>
                    <th className="py-1 font-normal">Counterparty</th>
                  </tr></thead>
                  <tbody>
                    {item.transactions.map((t) => (
                      <tr key={t.id} className="border-t">
                        <td className="py-1 pr-3">{new Date(t.bookedAt).toLocaleDateString("nl-NL")}</td>
                        <td className="py-1 pr-3">{formatEuro(t.amountCents)}</td>
                        <td className="py-1">{t.counterpartyName ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
          <section>
            <h2 className="font-semibold mb-2">Linked documents</h2>
            {item.documents.length === 0
              ? <p className="text-sm text-slate-600">No documents linked yet.</p>
              : (
                <ul className="space-y-1">
                  {item.documents.map((d) => (
                    <li key={d.id}>
                      <Link href={`/vault/${d.id}`} className="text-sm underline">{d.title}</Link>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>
        <div className="space-y-6" id="decide">
          <DecisionForm kind="item" targetId={item.id}
            currentStatus={item.effectiveStatus}
            documents={vaultDocs.map((d) => ({ id: d.id, title: d.effectiveTitle }))} />
          <section>
            <h2 className="font-semibold mb-2">Decision trail — every step on record</h2>
            <DecisionTimeline decisions={item.decisions} kind="item" docTitles={docTitles} />
          </section>
        </div>
      </div>
    </div>
  );
}
