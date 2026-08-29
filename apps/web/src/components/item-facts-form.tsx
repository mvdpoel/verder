"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { euroToCents } from "./registry-item-form";
import {
  Button,
  Field,
  FormError,
  Input,
  Label,
  Notice,
  Panel,
  Select,
  Textarea,
} from "@/components/ui";

// Editable facts panels for the registry detail screens. Facts are editable
// (a typo is a typo); decisions live in the ledger-backed DecisionForm instead.
// Which is why "Save facts" is a ghost button on both screens: the deliberate,
// permanent act on these pages is the decision, and it owns the one glow.

const CATEGORIES = ["energy", "insurance", "telecom", "streaming", "software", "housing", "other"] as const;
const CYCLES = ["monthly", "quarterly", "yearly", "irregular"] as const;
const CHANNELS = ["direct-debit", "paypal", "apple", "invoice"] as const;

const AMOUNT_ERROR = "Use a plain amount like 12,50";

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
  const amountError = form.amount !== "" && amountCents === null;
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
    <Panel as="section" className="flex flex-col gap-[18px] p-[26px]">
      <Label as="h2">The facts</Label>
      <Field label="Name" htmlFor="facts-name">
        <Input id="facts-name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <div className="grid gap-[18px] sm:grid-cols-3">
        <Field label="Category" htmlFor="facts-category">
          <Select id="facts-category" value={form.category}
            onChange={(e) => set({ category: e.target.value as typeof form.category })}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Amount (€)" htmlFor="facts-amount" error={amountError ? AMOUNT_ERROR : undefined}>
          <Input id="facts-amount" inputMode="decimal" className="font-mono" invalid={amountError}
            value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
        </Field>
        <Field label="Billing cycle" htmlFor="facts-cycle">
          <Select id="facts-cycle" value={form.billingCycle}
            onChange={(e) => set({ billingCycle: e.target.value as typeof form.billingCycle })}>
            {CYCLES.map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid gap-[18px] sm:grid-cols-3">
        <Field label="Payment channel" htmlFor="facts-channel">
          <Select id="facts-channel" value={form.paymentChannel}
            onChange={(e) => set({ paymentChannel: e.target.value as typeof form.paymentChannel })}>
            {CHANNELS.map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Contract start" htmlFor="facts-start">
          <Input id="facts-start" type="date" className="font-mono"
            value={form.contractStart} onChange={(e) => set({ contractStart: e.target.value })} />
        </Field>
        <Field label="Contract end" htmlFor="facts-end">
          <Input id="facts-end" type="date" className="font-mono"
            value={form.contractEnd} onChange={(e) => set({ contractEnd: e.target.value })} />
        </Field>
      </div>
      <div className="grid gap-[18px] sm:grid-cols-3">
        <Field label="Notice period" htmlFor="facts-notice">
          <Input id="facts-notice" placeholder="e.g. 1 month"
            value={form.noticePeriod} onChange={(e) => set({ noticePeriod: e.target.value })} />
        </Field>
        <Field label="Cancellation via" htmlFor="facts-method">
          <Input id="facts-method" placeholder="email, phone, letter, portal"
            value={form.cancellationMethod} onChange={(e) => set({ cancellationMethod: e.target.value })} />
        </Field>
        <Field label="Account / customer nr" htmlFor="facts-account">
          <Input id="facts-account" className="font-mono"
            value={form.accountNumber} onChange={(e) => set({ accountNumber: e.target.value })} />
        </Field>
      </div>
      <Field label="Cancellation details" htmlFor="facts-details">
        <Textarea id="facts-details" rows={2} placeholder="address, portal link, what to mention…"
          value={form.cancellationDetails} onChange={(e) => set({ cancellationDetails: e.target.value })} />
      </Field>
      {update.error && (
        <FormError>{update.error.message}</FormError>
      )}
      <div className="flex pt-1">
        <Button variant="ghost" size="sm"
          disabled={!form.name || amountCents === null || update.isPending} onClick={save}>
          Save facts
        </Button>
      </div>
    </Panel>
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
    <Panel as="section" className="flex flex-col gap-[18px] p-[26px]">
      <Label as="h2">The facts</Label>
      <Field label="Creditor" htmlFor="debt-facts-creditor">
        <Input id="debt-facts-creditor" value={form.creditorName}
          onChange={(e) => set({ creditorName: e.target.value })} />
      </Field>
      <div className="grid gap-[18px] sm:grid-cols-3">
        <Field label="Principal (€)" htmlFor="debt-facts-principal"
          error={principalOk ? undefined : AMOUNT_ERROR}>
          <Input id="debt-facts-principal" inputMode="decimal" className="font-mono"
            placeholder="what it started as" invalid={!principalOk}
            value={form.principal} onChange={(e) => set({ principal: e.target.value })} />
        </Field>
        {/* An empty Claimed is a real answer — the KvK aanmaning states no
            total — so the placeholder says so rather than the field nagging. */}
        <Field label="Claimed (€)" htmlFor="debt-facts-claimed"
          error={claimedOk ? undefined : AMOUNT_ERROR}>
          <Input id="debt-facts-claimed" inputMode="decimal" className="font-mono"
            placeholder="leave empty if the notice states none" invalid={!claimedOk}
            value={form.claimed} onChange={(e) => set({ claimed: e.target.value })} />
        </Field>
        <Field label="References" htmlFor="debt-facts-references">
          <Input id="debt-facts-references" className="font-mono" placeholder="dossier / invoice nr"
            value={form.references} onChange={(e) => set({ references: e.target.value })} />
        </Field>
      </div>
      <div className="grid gap-[18px] sm:grid-cols-3">
        <Field label="Origin" htmlFor="debt-facts-origin">
          <Input id="debt-facts-origin" placeholder="business / private"
            value={form.origin} onChange={(e) => set({ origin: e.target.value })} />
        </Field>
        <Field label="Origin story" htmlFor="debt-facts-story" className="sm:col-span-2">
          <Textarea id="debt-facts-story" rows={2}
            placeholder="how this one came to be — no judgement, just the story"
            value={form.originStory} onChange={(e) => set({ originStory: e.target.value })} />
        </Field>
      </div>
      {update.error && (
        <FormError>{update.error.message}</FormError>
      )}
      <div className="flex pt-1">
        <Button variant="ghost" size="sm"
          disabled={!form.creditorName || !principalOk || !claimedOk || update.isPending} onClick={save}>
          Save facts
        </Button>
      </div>
    </Panel>
  );
}
