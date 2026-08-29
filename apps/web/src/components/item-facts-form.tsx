"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { euroToCents } from "./registry-item-form";

// Editable facts panels for the registry detail screens. Facts are editable
// (a typo is a typo); decisions live in the ledger-backed DecisionForm instead.

const CATEGORIES = ["energy", "insurance", "telecom", "streaming", "software", "housing", "other"] as const;
const CYCLES = ["monthly", "quarterly", "yearly", "irregular"] as const;
const CHANNELS = ["direct-debit", "paypal", "apple", "invoice"] as const;

/** Integer cents → "142,80" input text. Integer math only. */
function centsToInput(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

export type ItemFacts = {
  id: string;
  name: string;
  category: string;
  amountCents: number;
  billingCycle: string;
  paymentChannel: string;
  contractStart: string | null;
  contractEnd: string | null;
  noticePeriod: string | null;
  cancellationMethod: string | null;
  cancellationDetails: string | null;
  accountNumber: string | null;
};

export function ItemFactsForm({ item }: { item: ItemFacts }) {
  const router = useRouter();
  const update = trpc.registry.items.update.useMutation({ onSuccess: () => router.refresh() });
  const [form, setForm] = useState({
    name: item.name,
    category: item.category as (typeof CATEGORIES)[number],
    amount: centsToInput(item.amountCents),
    billingCycle: item.billingCycle as (typeof CYCLES)[number],
    paymentChannel: item.paymentChannel as (typeof CHANNELS)[number],
    contractStart: item.contractStart ?? "",
    contractEnd: item.contractEnd ?? "",
    noticePeriod: item.noticePeriod ?? "",
    cancellationMethod: item.cancellationMethod ?? "",
    cancellationDetails: item.cancellationDetails ?? "",
    accountNumber: item.accountNumber ?? "",
  });
  const amountCents = euroToCents(form.amount);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const save = () => {
    if (amountCents === null || !form.name) return;
    update.mutate({
      id: item.id,
      name: form.name,
      category: form.category,
      amountCents,
      billingCycle: form.billingCycle,
      paymentChannel: form.paymentChannel,
      contractStart: form.contractStart || null,
      contractEnd: form.contractEnd || null,
      noticePeriod: form.noticePeriod || null,
      cancellationMethod: form.cancellationMethod || null,
      cancellationDetails: form.cancellationDetails || null,
      accountNumber: form.accountNumber || null,
    });
  };

  return (
    <section className="rounded border bg-white p-4 space-y-3">
      <h2 className="font-semibold">The facts</h2>
      <label className="block text-sm">Name<input className="w-full border rounded p-2"
        value={form.name} onChange={(e) => set({ name: e.target.value })} /></label>
      <div className="grid grid-cols-3 gap-3">
        <label className="block text-sm">Category<select className="w-full border rounded p-2"
          value={form.category} onChange={(e) => set({ category: e.target.value as typeof form.category })}>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="block text-sm">Amount (€)<input className="w-full border rounded p-2"
          value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
          {form.amount && amountCents === null &&
            <span className="text-xs text-red-600">Use a plain amount like 12,50</span>}</label>
        <label className="block text-sm">Billing cycle<select className="w-full border rounded p-2"
          value={form.billingCycle} onChange={(e) => set({ billingCycle: e.target.value as typeof form.billingCycle })}>
          {CYCLES.map((c) => <option key={c}>{c}</option>)}</select></label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <label className="block text-sm">Payment channel<select className="w-full border rounded p-2"
          value={form.paymentChannel} onChange={(e) => set({ paymentChannel: e.target.value as typeof form.paymentChannel })}>
          {CHANNELS.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="block text-sm">Contract start<input type="date" className="w-full border rounded p-2"
          value={form.contractStart} onChange={(e) => set({ contractStart: e.target.value })} /></label>
        <label className="block text-sm">Contract end<input type="date" className="w-full border rounded p-2"
          value={form.contractEnd} onChange={(e) => set({ contractEnd: e.target.value })} /></label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <label className="block text-sm">Notice period<input className="w-full border rounded p-2" placeholder="e.g. 1 month"
          value={form.noticePeriod} onChange={(e) => set({ noticePeriod: e.target.value })} /></label>
        <label className="block text-sm">Cancellation via<input className="w-full border rounded p-2" placeholder="email, phone, letter, portal"
          value={form.cancellationMethod} onChange={(e) => set({ cancellationMethod: e.target.value })} /></label>
        <label className="block text-sm">Account / customer nr<input className="w-full border rounded p-2"
          value={form.accountNumber} onChange={(e) => set({ accountNumber: e.target.value })} /></label>
      </div>
      <label className="block text-sm">Cancellation details<textarea className="w-full border rounded p-2" rows={2}
        placeholder="address, portal link, what to mention…"
        value={form.cancellationDetails} onChange={(e) => set({ cancellationDetails: e.target.value })} /></label>
      {update.error && <p className="text-sm text-red-600">{update.error.message}</p>}
      <button className="rounded bg-slate-900 text-white px-4 py-2 disabled:opacity-50"
        disabled={!form.name || amountCents === null || update.isPending} onClick={save}>
        Save facts
      </button>
    </section>
  );
}

export type DebtFacts = {
  id: string;
  creditorName: string;
  principalCents: number | null;
  // The KvK aanmaning names no total — a debt CAN be uneditable-proof against
  // that, never uneditable because of it. Mirrors principalCents exactly.
  claimedCents: number | null;
  references_: string | null;
  origin: string | null;
  originStory: string | null;
};

export function DebtFactsForm({ debt }: { debt: DebtFacts }) {
  const router = useRouter();
  const update = trpc.registry.debts.update.useMutation({ onSuccess: () => router.refresh() });
  const [form, setForm] = useState({
    creditorName: debt.creditorName,
    principal: debt.principalCents === null ? "" : centsToInput(debt.principalCents),
    claimed: debt.claimedCents === null ? "" : centsToInput(debt.claimedCents),
    references: debt.references_ ?? "",
    origin: debt.origin ?? "",
    originStory: debt.originStory ?? "",
  });
  const principalCents = form.principal.trim() === "" ? null : euroToCents(form.principal);
  const claimedCents = form.claimed.trim() === "" ? null : euroToCents(form.claimed);
  const principalOk = form.principal.trim() === "" || principalCents !== null;
  const claimedOk = form.claimed.trim() === "" || claimedCents !== null;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const save = () => {
    if (!form.creditorName || !principalOk || !claimedOk) return;
    update.mutate({
      id: debt.id,
      creditorName: form.creditorName,
      principalCents,
      claimedCents,
      references: form.references || null,
      origin: form.origin || null,
      originStory: form.originStory || null,
    });
  };

  return (
    <section className="rounded border bg-white p-4 space-y-3">
      <h2 className="font-semibold">The facts</h2>
      <label className="block text-sm">Creditor<input className="w-full border rounded p-2"
        value={form.creditorName} onChange={(e) => set({ creditorName: e.target.value })} /></label>
      <div className="grid grid-cols-3 gap-3">
        <label className="block text-sm">Principal (€)<input className="w-full border rounded p-2" placeholder="what it started as"
          value={form.principal} onChange={(e) => set({ principal: e.target.value })} />
          {!principalOk && <span className="text-xs text-red-600">Use a plain amount like 12,50</span>}</label>
        <label className="block text-sm">Claimed (€)<input className="w-full border rounded p-2" placeholder="leave empty if the notice states none"
          value={form.claimed} onChange={(e) => set({ claimed: e.target.value })} />
          {!claimedOk && <span className="text-xs text-red-600">Use a plain amount like 12,50</span>}</label>
        <label className="block text-sm">References<input className="w-full border rounded p-2" placeholder="dossier / invoice nr"
          value={form.references} onChange={(e) => set({ references: e.target.value })} /></label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <label className="block text-sm">Origin<input className="w-full border rounded p-2" placeholder="business / private"
          value={form.origin} onChange={(e) => set({ origin: e.target.value })} /></label>
        <label className="block col-span-2 text-sm">Origin story<textarea className="w-full border rounded p-2" rows={2}
          placeholder="how this one came to be — no judgement, just the story"
          value={form.originStory} onChange={(e) => set({ originStory: e.target.value })} /></label>
      </div>
      {update.error && <p className="text-sm text-red-600">{update.error.message}</p>}
      <button className="rounded bg-slate-900 text-white px-4 py-2 disabled:opacity-50"
        disabled={!form.creditorName || !principalOk || !claimedOk || update.isPending} onClick={save}>
        Save facts
      </button>
    </section>
  );
}
