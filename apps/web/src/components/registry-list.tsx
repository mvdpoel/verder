import Link from "next/link";
import {
  Chip,
  Empty,
  Label,
  Micro,
  Panel,
  Row,
  TextLink,
  type ChipTone,
  type DotState,
} from "@/components/ui";

// Presentational (server-safe) lists for the registry overview.
// Money is integer cents everywhere; formatting stays in integer math.

export type RegistryItemRow = {
  id: string;
  name: string;
  category: string;
  amountCents: number;
  billingCycle: string;
  paymentChannel: string;
  discoveredVia: string;
  effectiveStatus: string;
  monthlyCents: number;
};

export type DebtPartyRole = "eiser" | "incasso" | "deurwaarder" | "gemachtigde";

export type RegistryDebtPartyRow = {
  partyId: string;
  name: string;
  organization: string | null;
  role: DebtPartyRole;
  note: string | null;
};

export type RegistryDebtRow = {
  id: string;
  creditorName: string;
  claimedCents: number | null;
  effectiveStatus: string;
  // Who is chasing this debt (eiser) and who is acting for them
  // (incasso/deurwaarder/gemachtigde) — Task 2's debt_parties edge.
  parties: RegistryDebtPartyRow[];
  // Whether Martin has told Verder about this debt yet. null means not yet —
  // reported calmly, never as a warning: three creditors are already chasing
  // him and this screen's job is to state what is recorded, not to alarm.
  reportedToVerderAt: Date | null;
};

export const ITEM_STATUS_ORDER = [
  "identified", "mandatory", "allowed", "requested", "to-cancel", "canceled",
] as const;

export const DEBT_STATUS_ORDER = [
  "identified", "acknowledged", "disputed", "in-settlement", "settled",
] as const;

/**
 * Statuses carry a chip tone, never amber.
 *
 * Amber says "this waits on Martin", and it earns that by being rare. A
 * registry of thirty subscriptions all sitting at `identified` would paint the
 * whole page amber and the marker would stop meaning anything — so the waiting
 * is said ONCE, on the `identified` group's own label below, and the rows
 * themselves stay in the ink ramp.
 */
const ITEM_STATUS_TONE: Record<string, ChipTone> = {
  identified: "faint",
  mandatory: "mute",
  allowed: "okay",
  requested: "signal",
  "to-cancel": "signal",
  canceled: "faint",
};

const DEBT_STATUS_TONE: Record<string, ChipTone> = {
  identified: "faint",
  acknowledged: "mute",
  disputed: "signal",
  "in-settlement": "signal",
  settled: "okay",
};

/** A canceled subscription is struck through — the one status that reads as gone. */
const STATUS_EXTRA: Record<string, string> = { canceled: "line-through" };

const ITEM_STATUS_DOT: Record<string, DotState> = {
  identified: "open",
  mandatory: "done",
  allowed: "done",
  // "Requested" waits on the provider's verdict, not on Martin: the dim fill.
  requested: "waiting",
  "to-cancel": "open",
  canceled: "done",
};

const DEBT_STATUS_DOT: Record<string, DotState> = {
  identified: "open",
  acknowledged: "done",
  disputed: "open",
  "in-settlement": "open",
  settled: "done",
};

const ITEM_GROUP_LABEL: Record<string, string> = {
  identified: "Identified — waiting for a first decision",
  mandatory: "Mandatory — these have to stay",
  allowed: "Allowed — approved to keep",
  requested: "Requested — waiting for a verdict",
  "to-cancel": "To cancel — on the way out",
  canceled: "Canceled — done and dusted",
};

/**
 * €-format integer cents without float arithmetic. `null` means the notice
 * never stated an amount (the KvK aanmaning is the real example) — rendering
 * that as €0,00 would put a number in front of Martin that no creditor ever
 * claimed, so it renders as text instead.
 */
export function formatEuro(cents: number | null): string {
  if (cents === null) return "amount unknown";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}€${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function StatusBadge({ status, kind }: { status: string; kind: "item" | "debt" }) {
  const tone = (kind === "item" ? ITEM_STATUS_TONE : DEBT_STATUS_TONE)[status] ?? "faint";
  return <Chip tone={tone} className={STATUS_EXTRA[status]}>{status}</Chip>;
}

function SourceBadge({ source }: { source: string }) {
  return <Chip tone="faint">via {source}</Chip>;
}

export type DecisionRow = {
  id: string;
  status: string;
  explanation: string;
  createdAt: Date;
  documentId: string | null;
  blockerNote: string | null;
  overrideReason: string | null;
};

/** Read-only ledger-backed decision timeline, newest first. */
export function DecisionTimeline({ decisions, kind, docTitles }: {
  decisions: DecisionRow[];
  kind: "item" | "debt";
  docTitles: Map<string, string>;
}) {
  if (decisions.length === 0) {
    // Written as a JS string, not JSX text, so the straight quotes survive
    // exactly as they were — a tested copy line is not the place for entities.
    return <Empty title={'No decisions yet — that\'s fine, it starts as "identified". The first call is yours to make below.'} />;
  }
  return (
    <ol>
      {decisions.map((d) => (
        <li key={d.id} className="border-b border-hairline py-[14px] last:border-0">
          <div className="flex flex-wrap items-center gap-[10px]">
            <StatusBadge status={d.status} kind={kind} />
            <Micro>{new Date(d.createdAt).toLocaleString("nl-NL")}</Micro>
            {d.documentId && (
              <TextLink
                href={`/vault/${d.documentId}`}
                className="micro truncate">
                {docTitles.get(d.documentId) ?? "document"}
              </TextLink>
            )}
          </div>
          <p className="mt-[9px] text-[13.5px] font-light leading-relaxed whitespace-pre-wrap text-ink-soft">
            {d.explanation}
          </p>
          {/* A blocker is something standing between Martin and the next step,
              which is the one thing amber is for. */}
          {d.blockerNote && (
            <p className="mt-[7px] font-mono text-[10px] tracking-[0.12em] text-attn">
              Blocker: {d.blockerNote}
            </p>
          )}
          {d.overrideReason && (
            <p className="mt-[7px] font-mono text-[10px] tracking-[0.12em] text-ink-dim">
              Off the usual path — {d.overrideReason}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

const EMPTY_STATE = "Nothing here yet — import a bank statement and let's find out together what's out there.";

export function RegistryItemsList({ items }: { items: RegistryItemRow[] }) {
  if (items.length === 0) return <Empty title={EMPTY_STATE} />;
  const groups = ITEM_STATUS_ORDER
    .map((status) => ({ status, rows: items.filter((i) => i.effectiveStatus === status) }))
    .filter((g) => g.rows.length > 0);
  return (
    <div className="flex flex-col gap-5">
      {groups.map(({ status, rows }) => {
        const rollupCents = rows.reduce((sum, r) => sum + r.monthlyCents, 0);
        return (
          <Panel key={status}>
            <div className="flex flex-col gap-2 px-[26px] py-[22px]">
              <div className="flex items-baseline justify-between gap-4">
                {/* The one amber mark in this list: these are the rows whose
                    next move is Martin's own first decision. */}
                <Label className={status === "identified" ? "text-attn" : undefined}>
                  {ITEM_GROUP_LABEL[status] ?? status}
                </Label>
                <div className="shrink-0 font-mono text-[10px] tracking-[0.14em] uppercase text-ink-dim">
                  {formatEuro(rollupCents)}/mo
                </div>
              </div>
              <div>
                {rows.map((item) => (
                  <Row
                    key={item.id}
                    state={ITEM_STATUS_DOT[item.effectiveStatus]}
                    title={
                      <span className="flex min-w-0 flex-wrap items-center gap-[10px]">
                        <Link
                          href={`/registry/${item.id}`}
                          className="truncate text-ink-bright transition-colors hover:text-signal-link">
                          {item.name}
                        </Link>
                        <StatusBadge status={item.effectiveStatus} kind="item" />
                        <SourceBadge source={item.discoveredVia} />
                      </span>
                    }
                    meta={`${item.category} · ${formatEuro(item.amountCents)}/${item.billingCycle} · ${formatEuro(item.monthlyCents)}/mo`}
                  />
                ))}
              </div>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

export function RegistryDebtsList({ debts }: { debts: RegistryDebtRow[] }) {
  if (debts.length === 0) return <Empty title={EMPTY_STATE} />;
  const ordered = [...debts].sort((a, b) =>
    DEBT_STATUS_ORDER.indexOf(a.effectiveStatus as (typeof DEBT_STATUS_ORDER)[number])
    - DEBT_STATUS_ORDER.indexOf(b.effectiveStatus as (typeof DEBT_STATUS_ORDER)[number]));
  return (
    <Panel>
      <div className="px-[26px] py-[10px]">
        {ordered.map((debt) => {
          const eiserNames = debt.parties.filter((p) => p.role === "eiser").map((p) => p.name);
          const intermediaries = debt.parties.filter((p) => p.role !== "eiser")
            .map((p) => `${p.role}: ${p.name}`);
          const hasKicker = eiserNames.length > 0 || intermediaries.length > 0
            || !debt.reportedToVerderAt;
          return (
            <Row
              key={debt.id}
              state={DEBT_STATUS_DOT[debt.effectiveStatus]}
              title={
                <span className="flex min-w-0 flex-wrap items-center gap-[10px]">
                  <Link
                    href={`/registry/debts/${debt.id}`}
                    className="truncate text-ink-bright transition-colors hover:text-signal-link">
                    {debt.creditorName}
                  </Link>
                  <StatusBadge status={debt.effectiveStatus} kind="debt" />
                </span>
              }
              // "Not reported to Verder yet" stays in the ink ramp on purpose:
              // it is a fact about the record, not an accusation.
              kicker={hasKicker ? (
                <>
                  {eiserNames.length > 0 && <>eiser: {eiserNames.join(", ")}</>}
                  {intermediaries.length > 0 && <>{eiserNames.length > 0 && " · "}{intermediaries.join(" · ")}</>}
                  {!debt.reportedToVerderAt && <>{(eiserNames.length > 0 || intermediaries.length > 0) && " · "}not reported to Verder yet</>}
                </>
              ) : undefined}
              meta={debt.claimedCents === null ? "amount unknown" : `claimed ${formatEuro(debt.claimedCents)}`}
            />
          );
        })}
      </div>
    </Panel>
  );
}
