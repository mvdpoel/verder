"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

const CATEGORIES = ["energy", "insurance", "telecom", "streaming", "software", "housing", "other"] as const;
const CYCLES = ["monthly", "quarterly", "yearly", "irregular"] as const;
const CHANNELS = ["direct-debit", "paypal", "apple", "invoice"] as const;

/** Parse a typed euro amount ("12,50" / "12.50" / "12") to integer cents. String math, never floats. */
export function euroToCents(s: string): number | null {
  const m = s.trim().replace(/[€\s]/g, "").match(/^(-?)(\d+)(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  const [, sign, euros, frac = ""] = m;
  const cents = parseInt(euros, 10) * 100 + (frac ? parseInt((frac + "0").slice(0, 2), 10) : 0);
  return sign ? -cents : cents;
}

export function RegistryItemForm() {
  const router = useRouter();
  const create = trpc.registry.items.create.useMutation({ onSuccess: () => router.push("/registry") });
  const [form, setForm] = useState({
    name: "",
    category: "other" as (typeof CATEGORIES)[number],
    amount: "",
    billingCycle: "monthly" as (typeof CYCLES)[number],
    paymentChannel: "direct-debit" as (typeof CHANNELS)[number],
    accountNumber: "",
    noticePeriod: "",
  });
  const amountCents = euroToCents(form.amount);

  const submit = () => {
    if (amountCents === null || !form.name) return;
    create.mutate({
      name: form.name,
      category: form.category,
      amountCents,
      billingCycle: form.billingCycle,
      paymentChannel: form.paymentChannel,
      accountNumber: form.accountNumber || undefined,
      noticePeriod: form.noticePeriod || undefined,
      discoveredVia: "manual",
    });
  };

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-bold">Add to the registry</h1>
      <p className="text-sm text-slate-600">A subscription or running contract — getting it on the list is the win here.</p>
      <label className="block">Name<input className="w-full border rounded p-2" placeholder="e.g. Eneco energie"
        value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <div className="grid grid-cols-3 gap-3">
        <label className="block">Category<select className="w-full border rounded p-2" value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value as typeof form.category })}>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="block">Amount (€)<input className="w-full border rounded p-2" placeholder="12,50"
          value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          {form.amount && amountCents === null &&
            <span className="text-xs text-red-600">Use a plain amount like 12,50</span>}</label>
        <label className="block">Billing cycle<select className="w-full border rounded p-2" value={form.billingCycle}
          onChange={(e) => setForm({ ...form, billingCycle: e.target.value as typeof form.billingCycle })}>
          {CYCLES.map((c) => <option key={c}>{c}</option>)}</select></label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <label className="block">Payment channel<select className="w-full border rounded p-2" value={form.paymentChannel}
          onChange={(e) => setForm({ ...form, paymentChannel: e.target.value as typeof form.paymentChannel })}>
          {CHANNELS.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="block">Account / customer nr<input className="w-full border rounded p-2"
          value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} /></label>
        <label className="block">Notice period<input className="w-full border rounded p-2" placeholder="e.g. 1 month"
          value={form.noticePeriod} onChange={(e) => setForm({ ...form, noticePeriod: e.target.value })} /></label>
      </div>
      <button className="rounded bg-slate-900 text-white px-6 py-2 disabled:opacity-50"
        disabled={!form.name || amountCents === null || create.isPending} onClick={submit}>
        Add to registry
      </button>
    </div>
  );
}
