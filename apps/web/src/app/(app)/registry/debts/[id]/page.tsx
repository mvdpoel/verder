import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { DecisionForm } from "@/components/decision-form";
import { DebtFactsForm } from "@/components/item-facts-form";
import { DecisionTimeline, StatusBadge, formatEuro } from "@/components/registry-list";

export default async function RegistryDebtPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const debt = await caller.registry.debts.get({ id });
  const vaultDocs = await caller.documents.list({ limit: 100 });
  const docTitles = new Map(debt.documents.map((d) => [d.id, d.title]));
  const blocker = debt.decisions[0]?.blockerNote;
  const feesCents = debt.principalCents === null ? null : debt.claimedCents - debt.principalCents;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{debt.creditorName}</h1>
        <StatusBadge status={debt.effectiveStatus} kind="debt" />
      </div>
      <p className="text-slate-600">
        Claimed <span className="font-semibold">{formatEuro(debt.claimedCents)}</span>
        {debt.principalCents !== null && (
          <> · started as {formatEuro(debt.principalCents)}
            {feesCents !== null && feesCents > 0 && <> ({formatEuro(feesCents)} in fees and interest on top)</>}
          </>
        )}
        {debt.references_ && <> · ref {debt.references_}</>}
      </p>
      {blocker && (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          Keep in mind: {blocker}
        </p>
      )}
      <div className="grid grid-cols-2 gap-8 items-start">
        <div className="space-y-6">
          <DebtFactsForm debt={{
            id: debt.id, creditorName: debt.creditorName,
            principalCents: debt.principalCents, claimedCents: debt.claimedCents,
            references_: debt.references_, origin: debt.origin, originStory: debt.originStory,
          }} />
          <section>
            <h2 className="font-semibold mb-2">From your logbook — contact with this creditor</h2>
            {debt.relatedEntries.length === 0
              ? <p className="text-sm text-slate-600">No logbook entries with this creditor yet. When letters or calls happen, log them — they show up here by themselves.</p>
              : (
                <ul className="space-y-1">
                  {debt.relatedEntries.map((e) => (
                    <li key={e.id} className="text-sm">
                      <Link href={`/logbook/${e.id}`} className="underline">{e.summary}</Link>
                      <span className="text-xs text-slate-500"> · {new Date(e.occurredAt).toLocaleDateString("nl-NL")} · {e.channel}</span>
                    </li>
                  ))}
                </ul>
              )}
          </section>
          <section>
            <h2 className="font-semibold mb-2">Linked documents</h2>
            {debt.documents.length === 0
              ? <p className="text-sm text-slate-600">No documents linked yet.</p>
              : (
                <ul className="space-y-1">
                  {debt.documents.map((d) => (
                    <li key={d.id}>
                      <Link href={`/vault/${d.id}`} className="text-sm underline">{d.title}</Link>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>
        <div className="space-y-6">
          <DecisionForm kind="debt" targetId={debt.id}
            currentStatus={debt.effectiveStatus}
            documents={vaultDocs.map((d) => ({ id: d.id, title: d.effectiveTitle }))} />
          <section>
            <h2 className="font-semibold mb-2">Settlement trail — every step on record</h2>
            <DecisionTimeline decisions={debt.decisions} kind="debt" docTitles={docTitles} />
          </section>
        </div>
      </div>
    </div>
  );
}
