"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { CATEGORY_LABEL } from "@/components/money-format";
import { BILLING_CYCLE_LABEL, PAYMENT_CHANNEL_LABEL } from "@/components/registry-list";
import { Button, Field, Input, Notice, PageTitle, Panel, Select } from "@/components/ui";

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
  const amountError = form.amount !== "" && amountCents === null;

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
    <div className="flex max-w-xl flex-col gap-7">
      <div className="flex flex-col gap-[10px]">
        <PageTitle>Toevoegen aan het register</PageTitle>
        <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
          Een abonnement of doorlopend contract — het op de lijst krijgen is hier de winst.
        </p>
      </div>
      <Panel lit>
        <div className="flex flex-col gap-[18px] p-[26px]">
          <Field label="Naam" htmlFor="new-item-name">
            <Input id="new-item-name" placeholder="bijv. Eneco energie"
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <div className="grid gap-[18px] sm:grid-cols-3">
            <Field label="Categorie" htmlFor="new-item-category">
              <Select id="new-item-category" value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as typeof form.category })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c}</option>)}
              </Select>
            </Field>
            <Field label="Bedrag (€)" htmlFor="new-item-amount"
              error={amountError ? "Vul een gewoon bedrag in, zoals 12,50" : undefined}>
              <Input id="new-item-amount" inputMode="decimal" placeholder="12,50" invalid={amountError}
                className="font-mono" value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </Field>
            <Field label="Frequentie" htmlFor="new-item-cycle">
              <Select id="new-item-cycle" value={form.billingCycle}
                onChange={(e) => setForm({ ...form, billingCycle: e.target.value as typeof form.billingCycle })}>
                {CYCLES.map((c) => <option key={c} value={c}>{BILLING_CYCLE_LABEL[c] ?? c}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid gap-[18px] sm:grid-cols-3">
            <Field label="Betaalwijze" htmlFor="new-item-channel">
              <Select id="new-item-channel" value={form.paymentChannel}
                onChange={(e) => setForm({ ...form, paymentChannel: e.target.value as typeof form.paymentChannel })}>
                {CHANNELS.map((c) => <option key={c} value={c}>{PAYMENT_CHANNEL_LABEL[c] ?? c}</option>)}
              </Select>
            </Field>
            <Field label="Klant- of contractnummer" htmlFor="new-item-account">
              <Input id="new-item-account" className="font-mono" value={form.accountNumber}
                onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
            </Field>
            <Field label="Opzegtermijn" htmlFor="new-item-notice">
              <Input id="new-item-notice" placeholder="bijv. 1 maand" value={form.noticePeriod}
                onChange={(e) => setForm({ ...form, noticePeriod: e.target.value })} />
            </Field>
          </div>
          <div className="flex pt-1">
            <Button variant="primary"
              disabled={!form.name || amountCents === null || create.isPending} onClick={submit}>
              Toevoegen aan het register
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
