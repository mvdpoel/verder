"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { formatEuro } from "@/components/registry-list";

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
type ProposedDebt = { creditorName?: string; claimedCents?: number; references?: string | null;
  counterpartyName?: string | null; chargeCount?: number; lastAt?: string };

type Suggestion = { id: string; kind: string; model: string | null; proposed: unknown;
  rawEmail: { fromAddr: string; subject: string; bodyText: string } | null;
  document: { sha256: string; mime: string; title: string } | null };

export function SuggestionCard({ s }: { s: Suggestion }) {
  if (s.kind === "document-meta") return <DocMetaCard s={s} />;
  if (s.kind === "registry-item") return <RegistryItemCard s={s} />;
  if (s.kind === "debt") return <DebtCard s={s} />;
  return <EntryCard s={s} />;
}

function EntryCard({ s }: { s: Suggestion }) {
  const router = useRouter();
  const p = s.proposed as Proposed | null;
  const [summary, setSummary] = useState(p?.summary ?? "");
  const [details, setDetails] = useState(p?.details ?? "");
  const approve = trpc.suggestions.approveEntry.useMutation({ onSuccess: () => router.refresh() });
  const reject = trpc.suggestions.reject.useMutation({ onSuccess: () => router.refresh() });
  if (!p) return null;
  return (
    <li className="rounded border bg-white p-4 space-y-3">
      <p className="text-sm text-slate-500">
        {s.rawEmail ? `Email from ${s.rawEmail.fromAddr}: “${s.rawEmail.subject}”` : "Detected item"}
        {s.model && <span> · suggested by {s.model}</span>}
      </p>
      <label className="block text-sm">Summary<input className="w-full border rounded p-2"
        value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
      <label className="block text-sm">Details<textarea className="w-full border rounded p-2" rows={3}
        value={details} onChange={(e) => setDetails(e.target.value)} /></label>
      {s.rawEmail && <details><summary className="cursor-pointer text-sm">Original email</summary>
        <pre className="text-xs whitespace-pre-wrap bg-slate-50 p-2 rounded">{s.rawEmail.bodyText}</pre></details>}
      <div className="flex gap-2">
        <button className="rounded bg-emerald-700 text-white px-4 py-1"
          onClick={() => approve.mutate({ id: s.id, entry: {
            occurredAt: new Date(p.occurredAt), channel: p.channel as "email", direction: p.direction,
            summary, details: details || undefined, source: "gmail-watch",
            participantPartyIds: [], documentIds: p.attachmentDocumentIds,
            actionItems: p.actionItems } })}>Add to the record</button>
        <button className="rounded border px-4 py-1" onClick={() => reject.mutate({ id: s.id })}>Not relevant</button>
      </div>
    </li>
  );
}

const ITEM_CATEGORIES = ["energy", "insurance", "telecom", "streaming", "software", "housing", "other"] as const;
type ItemCategory = (typeof ITEM_CATEGORIES)[number];
const CYCLE_SHORT: Record<string, string> = { monthly: "mo", quarterly: "qtr", yearly: "yr", irregular: "…" };

function chargeEvidence(p: { chargeCount?: number; transactionIds?: string[];
  typicalAmountCents?: number; amountCents?: number; billingCycle?: string; lastAt?: string }) {
  const count = p.chargeCount ?? p.transactionIds?.length ?? 0;
  const cents = Math.abs(p.amountCents ?? p.typicalAmountCents ?? 0);
  const cycle = CYCLE_SHORT[p.billingCycle ?? ""] ?? "mo";
  const last = p.lastAt
    ? new Date(p.lastAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;
  return `${count} charge${count === 1 ? "" : "s"} · ${formatEuro(cents)}/${cycle}${last ? ` · last ${last}` : ""}`;
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
    <li className="rounded border bg-white p-4 space-y-3">
      <p className="text-sm text-slate-500">
        Recurring charge found{p.counterpartyName ? ` — ${p.counterpartyName}` : ""}
        {s.model && <span> · suggested by {s.model}</span>}
      </p>
      <p className="text-sm text-slate-700">{chargeEvidence(p)}</p>
      {p.resolved === false && (
        <p className="rounded bg-amber-50 border border-amber-200 text-amber-800 text-sm p-2">
          Waiting for receipt lookup — you can also fill it in yourself.
        </p>
      )}
      {p.note && <p className="text-sm text-slate-600">{p.note}</p>}
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">Name<input className="w-full border rounded p-2"
          value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="block text-sm">Category<select className="w-full border rounded p-2"
          value={category} onChange={(e) => setCategory(e.target.value as ItemCategory)}>
          {ITEM_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
      </div>
      <div className="flex gap-2">
        <button className="rounded bg-emerald-700 text-white px-4 py-1 disabled:opacity-50"
          disabled={!name || approve.isPending || reject.isPending}
          onClick={() => approve.mutate({ id: s.id, item: {
            name, category, amountCents,
            billingCycle: (["monthly", "quarterly", "yearly", "irregular"].includes(p.billingCycle ?? "")
              ? p.billingCycle : "monthly") as "monthly",
            paymentChannel: (["direct-debit", "paypal", "apple", "invoice"].includes(p.paymentChannel ?? "")
              ? p.paymentChannel : "invoice") as "invoice",
            discoveredVia: (["manual", "bank", "paypal", "apple", "email"].includes(p.discoveredVia ?? "")
              ? p.discoveredVia : "bank") as "bank",
          } })}>Add to registry</button>
        <button className="rounded border px-4 py-1 disabled:opacity-50"
          disabled={approve.isPending || reject.isPending}
          onClick={() => reject.mutate({ id: s.id })}>
          Not a subscription</button>
      </div>
    </li>
  );
}

function DebtCard({ s }: { s: Suggestion }) {
  const router = useRouter();
  const p = s.proposed as ProposedDebt | null;
  const [creditorName, setCreditorName] = useState(p?.creditorName ?? p?.counterpartyName ?? "");
  const approve = trpc.suggestions.approveDebt.useMutation({ onSuccess: () => router.refresh() });
  const reject = trpc.suggestions.reject.useMutation({ onSuccess: () => router.refresh() });
  if (!p) return null;
  const claimedCents = Math.abs(p.claimedCents ?? 0);
  return (
    <li className="rounded border bg-white p-4 space-y-3">
      <p className="text-sm text-slate-500">
        Possible debt found
        {s.model && <span> · suggested by {s.model}</span>}
      </p>
      <p className="text-sm rounded bg-amber-50 border border-amber-200 text-amber-800 p-2">
        This looks like a debt collector — no judgement, just good to have it on the list.
      </p>
      <label className="block text-sm">Creditor<input className="w-full border rounded p-2"
        value={creditorName} onChange={(e) => setCreditorName(e.target.value)} /></label>
      <p className="text-sm text-slate-700">Claimed: {formatEuro(claimedCents)}</p>
      <div className="flex gap-2">
        <button className="rounded bg-emerald-700 text-white px-4 py-1 disabled:opacity-50"
          disabled={!creditorName || approve.isPending || reject.isPending}
          onClick={() => approve.mutate({ id: s.id, debt: {
            creditorName, claimedCents, references: p.references ?? undefined } })}>
          Add as debt</button>
        <button className="rounded border px-4 py-1 disabled:opacity-50"
          disabled={approve.isPending || reject.isPending}
          onClick={() => reject.mutate({ id: s.id })}>
          Not a debt</button>
      </div>
    </li>
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
    <li className="rounded border bg-white p-4 space-y-3">
      <p className="text-sm text-slate-500">
        {`Scanned document “${s.document.title}”`}
        {s.model && <span> · suggested by {s.model}</span>}
      </p>
      {s.document.mime.startsWith("image/")
        ? <img src={`/api/files/${s.document.sha256}`} alt={s.document.title}
            className="max-h-48 border rounded" />
        : <iframe src={`/api/files/${s.document.sha256}`} className="w-full h-48 border rounded"
            title={s.document.title} />}
      <label className="block text-sm">Title<input className="w-full border rounded p-2"
        value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="block text-sm">Type<input className="w-full border rounded p-2"
        value={docType} onChange={(e) => setDocType(e.target.value)} /></label>
      <div className="flex gap-2">
        <button className="rounded bg-emerald-700 text-white px-4 py-1"
          onClick={() => approve.mutate({ id: s.id, title, docType: docType || undefined })}>
          Looks right</button>
        <button className="rounded border px-4 py-1" onClick={() => reject.mutate({ id: s.id })}>Not relevant</button>
      </div>
    </li>
  );
}
