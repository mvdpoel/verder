"use client";
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { formatEuro } from "@/components/registry-list";
import { RetrievedRefs } from "@/components/retrieved-refs";
import { AlreadyHaveThis } from "@/components/already-have-this";
import { DocumentPreview } from "@/components/document-preview";
import { Button, Field, Input, Micro, Notice, Panel, Select, Textarea } from "@/components/ui";

type Proposed = { occurredAt: string; channel: string; direction: "inbound" | "outbound";
  summary: string; details: string; participantNames: string[];
  actionItems: { description: string; clarity: "clear" | "ambiguous" | "already-provided" }[];
  attachmentDocumentIds: string[] };
type ProposedDocMeta = { title: string; docType: string | null };

type ProposedRegistryItem = { name?: string; category?: string; amountCents?: number;
  billingCycle?: string; paymentChannel?: string; discoveredVia?: string;
  counterpartyName?: string | null; counterpartyIban?: string | null;
  chargeCount?: number; typicalAmountCents?: number; lastAt?: string;
  transactionIds?: string[]; aggregator?: "apple" | "paypal" | null;
  resolved?: boolean; note?: string };
type ProposedDebt = { creditorName?: string; claimedCents?: number | null; references?: string | null;
  counterpartyName?: string | null; chargeCount?: number; lastAt?: string };
type ProposedTask = { title?: string; details?: string; dueAt?: string | null;
  assigneeHint?: "martin" | "verdergroep" | "other"; rawEmailId?: string };

type Suggestion = { id: string; kind: string; model: string | null; proposed: unknown;
  retrievedRefs: unknown; documentRequest: string | null;
  rawEmail: { fromAddr: string; subject: string; bodyText: string } | null;
  document: { sha256: string; mime: string; title: string; sizeBytes: number } | null };

/**
 * The frame every suggestion sits in.
 *
 * A plain `Panel`, never `lit`: this page is a LIST of proposals, and a light
 * streak on each of them turns the accent into wallpaper. No amber anywhere on
 * a card either — a suggestion is the machine offering something, not the case
 * waiting on Martin, and amber has to keep meaning exactly one thing.
 */
function Card({ children }: { children: ReactNode }) {
  return (
    <li>
      <Panel>
        <div className="flex flex-col gap-[18px] p-[26px]">{children}</div>
      </Panel>
    </li>
  );
}

/**
 * Cyan is the system's own voice, and every control on this page holds a value
 * the system PROPOSED rather than one the record already carries. Tinting the
 * field labels is what keeps an editable suggestion from reading like a fact.
 */
function ProposalLabel({ children }: { children: ReactNode }) {
  return <span className="text-signal">{children}</span>;
}

/** Where the suggestion came from, and which model wrote it. Provenance, so mono. */
function Source({ model, children }: { model: string | null; children: ReactNode }) {
  return (
    <Micro className="leading-relaxed">
      {children}
      {model && <span className="text-ink-faint"> · voorgesteld door {model}</span>}
    </Micro>
  );
}

/** A measured fact the model is showing its work with — never editable. */
function Measured({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[11.5px] tracking-[0.1em] text-ink-soft">{children}</p>;
}

/**
 * The verdict bar. One affirmative and one dismissal, separated from the form
 * above by a hairline so the decision never reads as another field.
 *
 * The affirmative is `signal`, NOT `primary`. A queue of five proposals renders
 * five of these, and five gradient buttons each with their own glow is the glow
 * law broken exactly as it is written: a signal that appears five times on one
 * screen is decoration. `signal` keeps the cyan — so the affirmative still reads
 * as the affirmative next to a `ghost` dismissal — and spends no glow at all,
 * which leaves this page honestly without a primary button. That is the right
 * answer: nothing here is THE thing to press, because every card is.
 */
function Verdict({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-[10px] border-t border-hairline pt-[18px]">{children}</div>
  );
}

/** The original mail, closed by default: it is the source, not the proposal. */
function OriginalEmail({ bodyText }: { bodyText: string }) {
  return (
    <details>
      <summary className="cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-ink-dim transition-colors hover:text-signal">
        Oorspronkelijke e-mail
      </summary>
      <pre className="mt-[12px] max-h-72 overflow-auto rounded-chip border border-hairline bg-void/60 p-[14px] font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-mute">
        {bodyText}
      </pre>
    </details>
  );
}

export function SuggestionCard({ s }: { s: Suggestion }) {
  if (s.kind === "document-meta") return <DocMetaCard s={s} />;
  if (s.kind === "registry-item") return <RegistryItemCard s={s} />;
  if (s.kind === "debt") return <DebtCard s={s} />;
  if (s.kind === "task") return <TaskCard s={s} />;
  return <EntryCard s={s} />;
}

function TaskCard({ s }: { s: Suggestion }) {
  const router = useRouter();
  const p = s.proposed as ProposedTask | null;
  const [title, setTitle] = useState(p?.title ?? "");
  const [details, setDetails] = useState(p?.details ?? "");
  const [dueAt, setDueAt] = useState(p?.dueAt ?? ""); // YYYY-MM-DD or ""
  const [pickedDocId, setPickedDocId] = useState<string | null>(null);
  // "" = not seeded yet; the assigneeHint is resolved once parties load.
  const [assigneePartyId, setAssigneePartyId] = useState("");
  const [seeded, setSeeded] = useState(false);
  const parties = trpc.parties.list.useQuery();
  const approve = trpc.suggestions.approveTask.useMutation({ onSuccess: () => router.refresh() });
  const reject = trpc.suggestions.reject.useMutation({ onSuccess: () => router.refresh() });
  if (!p) return null;
  // Seed the assignee select from the miner's hint: "verdergroep" preselects
  // the party whose name matches /verder/i when one exists; otherwise blank.
  if (!seeded && parties.data) {
    if (p.assigneeHint === "verdergroep") {
      const match = parties.data.find((party) => /verder/i.test(party.name));
      if (match) setAssigneePartyId(match.id);
    }
    setSeeded(true);
  }
  const busy = approve.isPending || reject.isPending;
  return (
    <Card>
      <Source model={s.model}>
        {s.rawEmail ? `Uit e-mail · “${s.rawEmail.subject}”` : "Actiepunt gevonden"}
      </Source>
      <Field label={<ProposalLabel>Taak</ProposalLabel>} htmlFor={`${s.id}-task`}>
        <Input id={`${s.id}-task`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={<ProposalLabel>Toelichting</ProposalLabel>} htmlFor={`${s.id}-details`}>
        <Textarea id={`${s.id}-details`} rows={2}
          value={details} onChange={(e) => setDetails(e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={<ProposalLabel>Uiterlijk op</ProposalLabel>} htmlFor={`${s.id}-due`}>
          <Input id={`${s.id}-due`} type="date"
            value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </Field>
        <Field label={<ProposalLabel>Wie doet het</ProposalLabel>} htmlFor={`${s.id}-assignee`}>
          <Select id={`${s.id}-assignee`} value={assigneePartyId}
            onChange={(e) => setAssigneePartyId(e.target.value)}>
            <option value="">— nog niemand —</option>
            {(parties.data ?? []).map((party) =>
              <option key={party.id} value={party.id}>{party.name}</option>)}
          </Select>
        </Field>
      </div>
      {s.documentRequest && <AlreadyHaveThis suggestionId={s.id} request={s.documentRequest}
        selected={pickedDocId ? [pickedDocId] : []}
        onToggle={(id) => setPickedDocId((prev) => (prev === id ? null : id))} />}
      <RetrievedRefs refs={s.retrievedRefs} />
      {s.rawEmail && <OriginalEmail bodyText={s.rawEmail.bodyText} />}
      <Verdict>
        <Button variant="signal" size="sm" disabled={!title.trim() || busy}
          onClick={() => approve.mutate({ id: s.id, task: {
            title: title.trim(), details: details || undefined,
            dueAt: dueAt ? new Date(dueAt) : undefined,
            documentId: pickedDocId ?? undefined,
            assigneePartyId: assigneePartyId || undefined } })}>Taak toevoegen</Button>
        <Button variant="ghost" size="sm" disabled={busy}
          onClick={() => reject.mutate({ id: s.id })}>Geen taak</Button>
      </Verdict>
    </Card>
  );
}

function EntryCard({ s }: { s: Suggestion }) {
  const router = useRouter();
  const p = s.proposed as Proposed | null;
  const [summary, setSummary] = useState(p?.summary ?? "");
  const [details, setDetails] = useState(p?.details ?? "");
  const [pickedDocIds, setPickedDocIds] = useState<string[]>([]);
  const approve = trpc.suggestions.approveEntry.useMutation({ onSuccess: () => router.refresh() });
  const reject = trpc.suggestions.reject.useMutation({ onSuccess: () => router.refresh() });
  if (!p) return null;
  return (
    <Card>
      <Source model={s.model}>
        {s.rawEmail ? `E-mail van ${s.rawEmail.fromAddr}: “${s.rawEmail.subject}”` : "Gevonden item"}
      </Source>
      <Field label={<ProposalLabel>Samenvatting</ProposalLabel>} htmlFor={`${s.id}-summary`}>
        <Input id={`${s.id}-summary`} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <Field label={<ProposalLabel>Toelichting</ProposalLabel>} htmlFor={`${s.id}-details`}>
        <Textarea id={`${s.id}-details`} rows={3}
          value={details} onChange={(e) => setDetails(e.target.value)} />
      </Field>
      {s.documentRequest && <AlreadyHaveThis suggestionId={s.id} request={s.documentRequest}
        selected={pickedDocIds}
        onToggle={(id) => setPickedDocIds((prev) =>
          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])} />}
      <RetrievedRefs refs={s.retrievedRefs} />
      {s.rawEmail && <OriginalEmail bodyText={s.rawEmail.bodyText} />}
      <Verdict>
        <Button variant="signal" size="sm"
          onClick={() => approve.mutate({ id: s.id, entry: {
            occurredAt: new Date(p.occurredAt), channel: p.channel as "email", direction: p.direction,
            summary, details: details || undefined, source: "gmail-watch",
            participantPartyIds: [],
            documentIds: [...new Set([...p.attachmentDocumentIds, ...pickedDocIds])],
            actionItems: p.actionItems } })}>Vastleggen in het dossier</Button>
        <Button variant="ghost" size="sm"
          onClick={() => reject.mutate({ id: s.id })}>Niet relevant</Button>
      </Verdict>
    </Card>
  );
}

const ITEM_CATEGORIES = ["energy", "insurance", "telecom", "streaming", "software", "housing", "other"] as const;
type ItemCategory = (typeof ITEM_CATEGORIES)[number];
const CYCLE_SHORT: Record<string, string> = { monthly: "mnd", quarterly: "kwartaal", yearly: "jaar", irregular: "…" };

function chargeEvidence(p: { chargeCount?: number; transactionIds?: string[];
  typicalAmountCents?: number; amountCents?: number; billingCycle?: string; lastAt?: string }) {
  const count = p.chargeCount ?? p.transactionIds?.length ?? 0;
  const cents = Math.abs(p.amountCents ?? p.typicalAmountCents ?? 0);
  const cycle = CYCLE_SHORT[p.billingCycle ?? ""] ?? "mnd";
  // nl-NL, like every other date in the app. This was the one en-US call left:
  // it printed "Aug 22" in a Dutch sentence about a Dutch bank charge.
  const last = p.lastAt
    ? new Date(p.lastAt).toLocaleDateString("nl-NL", { month: "short", day: "numeric" })
    : null;
  return `${count} ${count === 1 ? "afschrijving" : "afschrijvingen"} · ${formatEuro(cents)}/${cycle}${last ? ` · laatst ${last}` : ""}`;
}

function RegistryItemCard({ s }: { s: Suggestion }) {
  const router = useRouter();
  const p = s.proposed as ProposedRegistryItem | null;
  const [name, setName] = useState(p?.name ?? p?.counterpartyName ?? "");
  const [category, setCategory] = useState<ItemCategory>(
    ITEM_CATEGORIES.includes(p?.category as ItemCategory) ? p!.category as ItemCategory : "other");
  const approve = trpc.suggestions.approveRegistryItem.useMutation({ onSuccess: () => router.refresh() });
  const reject = trpc.suggestions.reject.useMutation({ onSuccess: () => router.refresh() });
  if (!p) return null;
  const amountCents = Math.abs(p.amountCents ?? p.typicalAmountCents ?? 0);
  return (
    <Card>
      <Source model={s.model}>
        Terugkerende afschrijving gevonden{p.counterpartyName ? ` — ${p.counterpartyName}` : ""}
      </Source>
      <Measured>{chargeEvidence(p)}</Measured>
      {/*
        A lookup still running is the system talking about itself, so it is cyan
        and not amber — nothing here is blocked on Martin, he is only being told
        he may fill it in ahead of the machine.
      */}
      {p.resolved === false && (
        <Notice tone="signal">
          Wacht op het opzoeken van de bon — je mag het ook zelf invullen.
        </Notice>
      )}
      {p.note && <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">{p.note}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={<ProposalLabel>Naam</ProposalLabel>} htmlFor={`${s.id}-name`}>
          <Input id={`${s.id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={<ProposalLabel>Categorie</ProposalLabel>} htmlFor={`${s.id}-category`}>
          <Select id={`${s.id}-category`} value={category}
            onChange={(e) => setCategory(e.target.value as ItemCategory)}>
            {ITEM_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
      </div>
      <RetrievedRefs refs={s.retrievedRefs} />
      <Verdict>
        <Button variant="signal" size="sm"
          disabled={!name || approve.isPending || reject.isPending}
          onClick={() => approve.mutate({ id: s.id, item: {
            name, category, amountCents,
            billingCycle: (["monthly", "quarterly", "yearly", "irregular"].includes(p.billingCycle ?? "")
              ? p.billingCycle : "monthly") as "monthly",
            paymentChannel: (["direct-debit", "paypal", "apple", "invoice"].includes(p.paymentChannel ?? "")
              ? p.paymentChannel : "invoice") as "invoice",
            discoveredVia: (["manual", "bank", "paypal", "apple", "email"].includes(p.discoveredVia ?? "")
              ? p.discoveredVia : "bank") as "bank",
          } })}>Aan het register toevoegen</Button>
        <Button variant="ghost" size="sm"
          disabled={approve.isPending || reject.isPending}
          onClick={() => reject.mutate({ id: s.id })}>
          Geen abonnement</Button>
      </Verdict>
    </Card>
  );
}

function DebtCard({ s }: { s: Suggestion }) {
  const router = useRouter();
  const p = s.proposed as ProposedDebt | null;
  const [creditorName, setCreditorName] = useState(p?.creditorName ?? p?.counterpartyName ?? "");
  const approve = trpc.suggestions.approveDebt.useMutation({ onSuccess: () => router.refresh() });
  const reject = trpc.suggestions.reject.useMutation({ onSuccess: () => router.refresh() });
  if (!p) return null;
  // A notice that never states a total is unknown, not zero — `0` would
  // assert the creditor claims nothing.
  const claimedCents = p.claimedCents == null ? null : Math.abs(p.claimedCents);
  return (
    <Card>
      <Source model={s.model}>Mogelijke vordering gevonden</Source>
      {/*
        The copy says "no judgement" and the colour has to agree: a debt the
        model spotted is the system reporting, not a demand on Martin, so this
        line is cyan. Amber here would turn every creditor notice into an alarm.
      */}
      <Notice tone="signal">
        Dit lijkt op een incassopartij — geen oordeel, wel goed om op de lijst te hebben.
      </Notice>
      <Field label={<ProposalLabel>Schuldeiser</ProposalLabel>} htmlFor={`${s.id}-creditor`}>
        <Input id={`${s.id}-creditor`} value={creditorName}
          onChange={(e) => setCreditorName(e.target.value)} />
      </Field>
      <Measured>Gevorderd: {formatEuro(claimedCents)}</Measured>
      <RetrievedRefs refs={s.retrievedRefs} />
      <Verdict>
        <Button variant="signal" size="sm"
          disabled={!creditorName || approve.isPending || reject.isPending}
          onClick={() => approve.mutate({ id: s.id, debt: {
            creditorName, claimedCents, references: p.references ?? undefined } })}>
          Als vordering vastleggen</Button>
        <Button variant="ghost" size="sm"
          disabled={approve.isPending || reject.isPending}
          onClick={() => reject.mutate({ id: s.id })}>
          Geen vordering</Button>
      </Verdict>
    </Card>
  );
}

function DocMetaCard({ s }: { s: Suggestion }) {
  const router = useRouter();
  const p = s.proposed as ProposedDocMeta | null;
  const [title, setTitle] = useState(p?.title ?? s.document?.title ?? "");
  const [docType, setDocType] = useState(p?.docType ?? "");
  const approve = trpc.suggestions.approveDocumentMeta.useMutation({ onSuccess: () => router.refresh() });
  const reject = trpc.suggestions.reject.useMutation({ onSuccess: () => router.refresh() });
  if (!p || !s.document) return null;
  return (
    <Card>
      <Source model={s.model}>{`Gescand document “${s.document.title}”`}</Source>
      <DocumentPreview
        doc={{ sha256: s.document.sha256, title: s.document.title, mime: s.document.mime,
          sizeBytes: s.document.sizeBytes }}
        height="short" />
      <Field label={<ProposalLabel>Titel</ProposalLabel>} htmlFor={`${s.id}-title`}>
        <Input id={`${s.id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={<ProposalLabel>Soort</ProposalLabel>} htmlFor={`${s.id}-doctype`}>
        <Input id={`${s.id}-doctype`} value={docType} onChange={(e) => setDocType(e.target.value)} />
      </Field>
      <RetrievedRefs refs={s.retrievedRefs} />
      <Verdict>
        <Button variant="signal" size="sm"
          onClick={() => approve.mutate({ id: s.id, title, docType: docType || undefined })}>
          Klopt zo</Button>
        <Button variant="ghost" size="sm"
          onClick={() => reject.mutate({ id: s.id })}>Niet relevant</Button>
      </Verdict>
    </Card>
  );
}
