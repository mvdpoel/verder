"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import {
  Button, Dialog, Field, FormError, Input, Micro, Select, Textarea,
} from "@/components/ui";

/**
 * Structural, hand-written rather than derived from `serverCaller` — the
 * convention `files-table.tsx`'s `Row` already set for a client component
 * that only needs a few fields off a server type.
 */
type DocTypeOption = { key: string; label: string; n: number };
type PartyOption = { id: string; name: string };
type SourceValue = "" | "upload" | "nas-scan" | "email-attachment";
type StatusValue = "" | "inbox" | "filed" | "discarded";

// Same Dutch words `describeRule` (packages/api/src/bundle-rule.ts) renders a
// saved rule back into, so a rule reads the same whether it is being built or
// being shown.
const SOURCE_OPTIONS: { value: Exclude<SourceValue, "">; label: string }[] = [
  { value: "upload", label: "geüpload" },
  { value: "nas-scan", label: "gescand" },
  { value: "email-attachment", label: "uit de mail" },
];
const STATUS_OPTIONS: { value: Exclude<StatusValue, "">; label: string }[] = [
  { value: "inbox", label: "te sorteren" },
  { value: "filed", label: "opgeborgen" },
  { value: "discarded", label: "weggelegd" },
];

const EMPTY_RULE = { docType: "", partyId: "", source: "" as SourceValue, status: "" as StatusValue, from: "", to: "" };

/**
 * Create a bundle: the one card in the grid that is an action rather than a
 * thing, and the Dialog it opens.
 *
 * The rule fields map ONE-TO-ONE onto `bundleRuleSchema` — docType, partyId,
 * source, status, from, to — nothing invented, nothing left out. An empty
 * rule means "every document in the vault" and the schema refuses it, so
 * `ruleEmpty` disables the submit button before that round trip rather than
 * after it; the message sits right under the fields it is about; never amber
 * — it is guidance, not the field-level "you got this wrong" `Field` reserves
 * amber for.
 *
 * `trigger` lets the same component be the dashed grid card OR a plain
 * button for the empty state, which already draws its own dashed box —
 * nesting a second one inside it would read as two invitations stacked.
 */
export function BundleForm({
  docTypes, parties, trigger = "card",
}: {
  docTypes: DocTypeOption[];
  parties: PartyOption[];
  trigger?: "card" | "button";
}) {
  const router = useRouter();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<"manual" | "rule">("manual");
  const [rule, setRule] = useState(EMPTY_RULE);

  const create = trpc.bundles.create.useMutation({
    onSuccess: () => { close(); router.refresh(); },
  });

  function close() {
    setOpen(false);
    setName(""); setNote(""); setKind("manual"); setRule(EMPTY_RULE);
    create.reset();
  }

  const ruleFieldCount = Object.values(rule).filter((v) => v !== "").length;
  const ruleEmpty = kind === "rule" && ruleFieldCount === 0;
  const canSubmit = name.trim().length > 0 && !ruleEmpty && !create.isPending;

  function submit() {
    if (!canSubmit) return;
    if (kind === "manual") {
      create.mutate({ name: name.trim(), note: note.trim() || undefined, kind: "manual" });
      return;
    }
    create.mutate({
      name: name.trim(), note: note.trim() || undefined, kind: "rule",
      rule: {
        ...(rule.docType ? { docType: rule.docType } : {}),
        ...(rule.partyId ? { partyId: rule.partyId } : {}),
        ...(rule.source ? { source: rule.source } : {}),
        ...(rule.status ? { status: rule.status } : {}),
        ...(rule.from ? { from: new Date(rule.from) } : {}),
        ...(rule.to ? { to: new Date(rule.to) } : {}),
      },
    });
  }

  return (
    <>
      {trigger === "card" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex min-h-[148px] cursor-pointer flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-edge-strong p-[18px] text-center transition-colors hover:border-signal/50 focus:border-signal focus:outline-none"
        >
          <span className="text-2xl font-extralight leading-none text-signal/70">+</span>
          <span className="text-[13px] font-light text-ink-soft">Nieuwe bundel</span>
        </button>
      ) : (
        <Button variant="signal" size="sm" onClick={() => setOpen(true)}>+ Nieuwe bundel</Button>
      )}

      <Dialog
        open={open}
        onClose={close}
        title="Nieuwe bundel"
        footer={
          <>
            <Button variant="quiet" size="sm" onClick={close}>annuleren</Button>
            <Button variant="primary" size="sm" disabled={!canSubmit} onClick={submit}>
              Bundel maken
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Naam" htmlFor={`${uid}-name`}>
            <Input id={`${uid}-name`} placeholder="bijv. Bijzondere bijstand — bijlagen"
              value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Notitie (optioneel)" htmlFor={`${uid}-note`}>
            <Textarea id={`${uid}-note`} rows={2} value={note}
              onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Field label="Soort bundel" htmlFor={`${uid}-kind`}>
            <Select id={`${uid}-kind`} value={kind}
              onChange={(e) => setKind(e.target.value as "manual" | "rule")}>
              <option value="manual">handmatig — stukken die je zelf kiest</option>
              <option value="rule">volgens een regel — vult zichzelf aan</option>
            </Select>
          </Field>

          {kind === "rule" && (
            <div className="flex flex-col gap-4 rounded-panel border border-dashed border-edge-strong p-[14px]">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Soort (optioneel)" htmlFor={`${uid}-doctype`}>
                  <Select id={`${uid}-doctype`} value={rule.docType}
                    onChange={(e) => setRule({ ...rule, docType: e.target.value })}>
                    <option value="">— elke soort —</option>
                    {docTypes.map((d) => <option key={d.key} value={d.label}>{d.label} ({d.n})</option>)}
                  </Select>
                </Field>
                <Field label="Van wie (optioneel)" htmlFor={`${uid}-party`}>
                  <Select id={`${uid}-party`} value={rule.partyId}
                    onChange={(e) => setRule({ ...rule, partyId: e.target.value })}>
                    <option value="">— iedereen —</option>
                    {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field>
                <Field label="Bron (optioneel)" htmlFor={`${uid}-source`}>
                  <Select id={`${uid}-source`} value={rule.source}
                    onChange={(e) => setRule({ ...rule, source: e.target.value as SourceValue })}>
                    <option value="">— elke bron —</option>
                    {SOURCE_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </Select>
                </Field>
                <Field label="Status (optioneel)" htmlFor={`${uid}-status`}>
                  <Select id={`${uid}-status`} value={rule.status}
                    onChange={(e) => setRule({ ...rule, status: e.target.value as StatusValue })}>
                    <option value="">— elke status —</option>
                    {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </Select>
                </Field>
                <Field label="Vanaf (optioneel)" htmlFor={`${uid}-from`}>
                  <Input id={`${uid}-from`} type="date" value={rule.from}
                    onChange={(e) => setRule({ ...rule, from: e.target.value })} />
                </Field>
                <Field label="Tot (optioneel)" htmlFor={`${uid}-to`}>
                  <Input id={`${uid}-to`} type="date" value={rule.to}
                    onChange={(e) => setRule({ ...rule, to: e.target.value })} />
                </Field>
              </div>
              {ruleEmpty && (
                <FormError>
                  Kies minstens één voorwaarde — anders geldt de regel voor alles in de kluis
                </FormError>
              )}
            </div>
          )}

          {create.error && <FormError>{create.error.message}</FormError>}
        </div>
      </Dialog>
    </>
  );
}

/**
 * Rename and delete on an existing card.
 *
 * Delete is two-step and lives on the card itself rather than in a second
 * Dialog: the confirmation is not amber (Ruling 1 — a mis-click is not
 * "waiting on Martin" the way the map's amber marks are) and `signal` is the
 * system's own colour for "this is the one" on a list where every card
 * carries the same decision, per `button.tsx`'s own doc comment on that
 * variant.
 */
export function BundleCardActions({ bundle }: {
  bundle: { id: string; name: string; note: string | null };
}) {
  const router = useRouter();
  const uid = useId();
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(bundle.name);
  const [note, setNote] = useState(bundle.note ?? "");

  const rename = trpc.bundles.rename.useMutation({
    onSuccess: () => { setRenaming(false); router.refresh(); },
  });
  const remove = trpc.bundles.remove.useMutation({
    onSuccess: () => router.refresh(),
  });

  function openRename() {
    setName(bundle.name);
    setNote(bundle.note ?? "");
    rename.reset();
    setRenaming(true);
  }

  if (confirmingDelete) {
    return (
      <div className="flex flex-col items-end gap-2">
        <Micro>Verwijderen kan niet ongedaan worden gemaakt.</Micro>
        <div className="flex gap-2">
          <Button variant="quiet" size="sm" onClick={() => setConfirmingDelete(false)}>
            annuleren
          </Button>
          <Button variant="signal" size="sm" disabled={remove.isPending}
            onClick={() => remove.mutate({ id: bundle.id })}>
            ja, verwijderen
          </Button>
        </div>
        {remove.error && <FormError>{remove.error.message}</FormError>}
      </div>
    );
  }

  return (
    <>
      <div className="flex shrink-0 gap-2">
        <Button variant="quiet" size="sm" onClick={openRename}>hernoemen</Button>
        <Button variant="quiet" size="sm" onClick={() => setConfirmingDelete(true)}>verwijderen</Button>
      </div>

      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Bundel hernoemen"
        footer={
          <>
            <Button variant="quiet" size="sm" onClick={() => setRenaming(false)}>annuleren</Button>
            <Button variant="primary" size="sm" disabled={!name.trim() || rename.isPending}
              onClick={() => rename.mutate({
                id: bundle.id, name: name.trim(), note: note.trim() || undefined,
              })}>
              Opslaan
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Naam" htmlFor={`${uid}-rename-name`}>
            <Input id={`${uid}-rename-name`} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Notitie (optioneel)" htmlFor={`${uid}-rename-note`}>
            <Textarea id={`${uid}-rename-note`} rows={2} value={note}
              onChange={(e) => setNote(e.target.value)} />
          </Field>
          {rename.error && <FormError>{rename.error.message}</FormError>}
        </div>
      </Dialog>
    </>
  );
}
