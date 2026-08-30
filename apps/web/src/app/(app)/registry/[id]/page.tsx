import { serverCaller } from "@/lib/trpc-server";
import { orNotFound } from "@/lib/not-found";
import { DecisionForm } from "@/components/decision-form";
import { ItemFactsForm } from "@/components/item-facts-form";
import {
  BILLING_CYCLE_SHORT, DECISION_PICKER_LIMIT, DecisionTimeline, StatusBadge, formatEuro,
} from "@/components/registry-list";
import {
  Chip,
  Dot,
  Label,
  Micro,
  Notice,
  PageTitle,
  Panel,
  Table,
  TableWrap,
  Td,
  TextLink,
  Th,
  type ChipTone,
} from "@/components/ui";

/**
 * A task blocking this item is either still running (cyan) or parked on someone
 * else (the ink ramp). It never gets amber of its own: the block around the list
 * already carries the one "this waits on you" mark on the page.
 */
const TASK_STATUS_TONE: Record<string, ChipTone> = {
  open: "signal",
  "in-progress": "signal",
  waiting: "mute",
};

function TaskStatusBadge({ status }: { status: string }) {
  return <Chip tone={TASK_STATUS_TONE[status] ?? "faint"}>{status}</Chip>;
}

export default async function RegistryItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const [item, vaultDocs] = await Promise.all([
    orNotFound(caller.registry.items.get({ id })),
    caller.documents.list({ limit: DECISION_PICKER_LIMIT }),
  ]);
  const docTitles = new Map(item.documents.map((d) => [d.id, d.title]));
  const blocker = item.decisions[0]?.blockerNote;
  const blockingTasks = item.blockingTasks;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <PageTitle>{item.name}</PageTitle>
          <StatusBadge status={item.effectiveStatus} kind="item" />
        </div>
        <Micro>
          {item.category} · {formatEuro(item.amountCents)}/{BILLING_CYCLE_SHORT[item.billingCycle] ?? item.billingCycle} · {formatEuro(item.monthlyCents)}/mnd · gevonden via {item.discoveredVia}
        </Micro>
      </div>
      {blockingTasks.length > 0 && (
        // Amber earns its place here: this item cannot move until these tasks do.
        <Panel className="flex flex-col gap-3 border-attn/30 px-[22px] py-[18px]">
          <div className="flex items-start gap-[14px]">
            <Dot state="you" className="mt-[6px]" />
            <p className="text-[13.5px] font-light leading-relaxed text-ink-soft">
              {blocker
                ? <>Denk hieraan: {blocker}</>
                : <>Er staan nog een paar taken in de weg voordat dit verder kan — stap voor stap:</>}
            </p>
          </div>
          <ul className="flex flex-col gap-[9px] pl-[23px]">
            {blockingTasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-[10px]">
                <TaskStatusBadge status={t.effectiveStatus} />
                <TextLink
                  href={`/tasks/${t.id}`}
                  className="text-[13.5px] font-light">
                  {t.title}
                </TextLink>
                {t.dueAt && (
                  <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-ink-dim">
                    vóór {new Date(t.dueAt).toLocaleDateString("nl-NL")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {/* The cleared nudge only appears when linked tasks actually finished —
          a blockerNote that never had a task is still just a note to keep. */}
      {blockingTasks.length === 0 && item.clearedTaskCount > 0 && (
        <Notice tone="ok">
          Blokkade weg — klaar om te besluiten?{" "}
          <a href="#decide" className="text-signal transition-colors hover:text-signal-link">Leg de volgende stap hieronder vast.</a>{" "}
          {blocker && <span className="text-ink-mute">(De notitie was: {blocker})</span>}
        </Notice>
      )}
      {blockingTasks.length === 0 && item.clearedTaskCount === 0 && blocker && (
        <Notice tone="attn">Denk hieraan: {blocker}</Notice>
      )}
      <div className="grid items-start gap-7 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <ItemFactsForm item={{
            id: item.id, name: item.name, category: item.category,
            amountCents: item.amountCents, billingCycle: item.billingCycle,
            paymentChannel: item.paymentChannel,
            contractStart: item.contractStart, contractEnd: item.contractEnd,
            noticePeriod: item.noticePeriod, cancellationMethod: item.cancellationMethod,
            cancellationDetails: item.cancellationDetails, accountNumber: item.accountNumber,
          }} />
          <Panel as="section" className="flex min-w-0 flex-col gap-[14px] p-[26px]">
            <Label as="h2">Bewijs — afschrijvingen van je afschriften</Label>
            {item.transactions.length === 0
              ? <p className="text-[13px] font-light text-ink-label">Nog geen gekoppelde transacties.</p>
              : (
                <TableWrap>
                  <Table className="min-w-[420px]">
                    <thead><tr>
                      <Th>Datum</Th>
                      <Th className="text-right">Bedrag</Th>
                      <Th>Tegenpartij</Th>
                    </tr></thead>
                    <tbody>
                      {item.transactions.map((t) => (
                        <tr key={t.id}>
                          <Td className="pr-5 font-mono text-ink-dim whitespace-nowrap">
                            {new Date(t.bookedAt).toLocaleDateString("nl-NL")}
                          </Td>
                          <Td className="pr-5 text-right font-mono text-ink whitespace-nowrap">
                            {formatEuro(t.amountCents)}
                          </Td>
                          <Td>{t.counterpartyName ?? "—"}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </TableWrap>
              )}
          </Panel>
          <Panel as="section" className="flex flex-col gap-[14px] p-[26px]">
            <Label as="h2">Gekoppelde documenten</Label>
            {item.documents.length === 0
              ? <p className="text-[13px] font-light text-ink-label">Nog geen documenten gekoppeld.</p>
              : (
                <ul>
                  {item.documents.map((d) => (
                    <li key={d.id} className="border-b border-hairline py-[11px] last:border-0">
                      <TextLink
                        href={`/files/${d.id}`}
                        className="text-[13.5px] font-light">
                        {d.title}
                      </TextLink>
                    </li>
                  ))}
                </ul>
              )}
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-6" id="decide">
          <DecisionForm kind="item" targetId={item.id}
            currentStatus={item.effectiveStatus}
            documents={vaultDocs.map((d) => ({ id: d.id, title: d.effectiveTitle }))} />
          <Panel as="section" className="flex flex-col gap-[14px] p-[26px]">
            <Label as="h2">Besluitspoor — elke stap blijft staan</Label>
            <DecisionTimeline decisions={item.decisions} kind="item" docTitles={docTitles} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
