import { serverCaller } from "@/lib/trpc-server";
import { DecisionForm } from "@/components/decision-form";
import { DebtFactsForm } from "@/components/item-facts-form";
import { DebtPartiesForm } from "@/components/debt-parties-form";
import { DecisionTimeline, StatusBadge, formatEuro } from "@/components/registry-list";
import { Label, Notice, PageTitle, Panel, TextLink } from "@/components/ui";

export default async function RegistryDebtPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const debt = await caller.registry.debts.get({ id });
  const vaultDocs = await caller.documents.list({ limit: 100 });
  const docTitles = new Map(debt.documents.map((d) => [d.id, d.title]));
  const blocker = debt.decisions[0]?.blockerNote;
  // Both sides of the subtraction have to be known amounts — the KvK debt
  // states no claimed total, and computing fees against `null` would either
  // throw or silently coerce to NaN.
  const feesCents = debt.principalCents === null || debt.claimedCents === null
    ? null : debt.claimedCents - debt.principalCents;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <PageTitle>{debt.creditorName}</PageTitle>
          <StatusBadge status={debt.effectiveStatus} kind="debt" />
        </div>
        {/* formatEuro(null) reads "amount unknown", never € 0,00: a notice that
            states no total is not a claim for nothing. */}
        <p className="text-[13.5px] font-light text-ink-mute">
          Claimed <span className="font-mono text-ink">{formatEuro(debt.claimedCents)}</span>
          {debt.principalCents !== null && (
            <> · started as <span className="font-mono text-ink-soft">{formatEuro(debt.principalCents)}</span>
              {feesCents !== null && feesCents > 0 && <> (<span className="font-mono text-ink-soft">{formatEuro(feesCents)}</span> in fees and interest on top)</>}
            </>
          )}
          {debt.references_ && <> · ref <span className="font-mono text-ink-soft">{debt.references_}</span></>}
        </p>
      </div>
      {blocker && <Notice tone="attn">Keep in mind: {blocker}</Notice>}
      <div className="grid items-start gap-7 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <DebtFactsForm debt={{
            id: debt.id, creditorName: debt.creditorName,
            principalCents: debt.principalCents, claimedCents: debt.claimedCents,
            references_: debt.references_, origin: debt.origin, originStory: debt.originStory,
          }} />
          <Panel as="section" className="flex flex-col gap-[14px] p-[26px]">
            <Label as="h2">From your logbook — contact with this creditor</Label>
            {debt.relatedEntries.length === 0
              ? (
                <p className="text-[13px] font-light leading-relaxed text-ink-label">
                  No logbook entries with this creditor yet. When letters or calls happen, log them — they show up here by themselves.
                </p>
              )
              : (
                <ul>
                  {debt.relatedEntries.map((e) => (
                    <li key={e.id} className="border-b border-hairline py-[11px] last:border-0">
                      <TextLink
                        href={`/logbook/${e.id}`}
                        className="text-[13.5px] font-light">
                        {e.summary}
                      </TextLink>
                      {/* Kept on the same line, separator and all: the run
                          reads as one sentence in the record. */}
                      <span className="micro"> · {new Date(e.occurredAt).toLocaleDateString("nl-NL")} · {e.channel}</span>
                    </li>
                  ))}
                </ul>
              )}
          </Panel>
          <Panel as="section" className="flex flex-col gap-[14px] p-[26px]">
            <Label as="h2">Documents via decisions &amp; the logbook</Label>
            {debt.documents.length === 0
              ? <p className="text-[13px] font-light text-ink-label">No documents linked yet.</p>
              : (
                <ul>
                  {debt.documents.map((d) => (
                    <li key={d.id} className="border-b border-hairline py-[11px] last:border-0">
                      <TextLink
                        href={`/vault/${d.id}`}
                        className="text-[13.5px] font-light">
                        {d.title}
                      </TextLink>
                    </li>
                  ))}
                </ul>
              )}
          </Panel>
          <DebtPartiesForm
            debtId={debt.id}
            parties={debt.parties}
            debtDocuments={debt.debtDocuments}
            reportedToVerderAt={debt.reportedToVerderAt}
            reportedViaEntryId={debt.reportedViaEntryId}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <DecisionForm kind="debt" targetId={debt.id}
            currentStatus={debt.effectiveStatus}
            documents={vaultDocs.map((d) => ({ id: d.id, title: d.effectiveTitle }))} />
          <Panel as="section" className="flex flex-col gap-[14px] p-[26px]">
            <Label as="h2">Settlement trail — every step on record</Label>
            <DecisionTimeline decisions={debt.decisions} kind="debt" docTitles={docTitles} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
