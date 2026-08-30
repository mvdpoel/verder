"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { DEBT_STATUS_ORDER, DECISION_PICKER_LIMIT, ITEM_STATUS_ORDER } from "./registry-list";
import { Button, Field, FormError, Input, Label, Panel, Select, Textarea } from "@/components/ui";

/**
 * Records a status decision for an item or debt. The next status is
 * constrained to the valid transitions from the current status
 * (registry.validNext); picking any other status is still possible but
 * switches the form into the override path — the reason is then part of
 * the record. Every decision lands in the ledger; nothing is ever erased.
 *
 * This is the panel that LEADS both registry detail screens — a decision is
 * Martin's, ledgered and permanent — so it carries the lit edge and the one
 * primary button, and nothing else on those pages glows.
 */
export function DecisionForm({ kind, targetId, currentStatus, documents }: {
  kind: "item" | "debt";
  targetId: string;
  currentStatus: string;
  documents: { id: string; title: string }[];
}) {
  const router = useRouter();
  const validNext = trpc.registry.validNext.useQuery({ kind, from: currentStatus });
  const [status, setStatus] = useState("");
  const [explanation, setExplanation] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [blockerNote, setBlockerNote] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const decide = trpc.registry.decide.useMutation({
    onSuccess: () => {
      setStatus(""); setExplanation(""); setDocumentId("");
      setBlockerNote(""); setOverrideReason("");
      router.refresh();
    },
  });

  const allStatuses = kind === "item" ? ITEM_STATUS_ORDER : DEBT_STATUS_ORDER;
  const valid: string[] = validNext.data ?? [];
  const options = allStatuses.filter((s) => s !== currentStatus);
  const needsOverride = status !== "" && !valid.includes(status);
  const ready = status !== "" && explanation.trim() !== ""
    && (!needsOverride || overrideReason.trim() !== "");

  const submit = () => {
    if (!ready) return;
    decide.mutate({
      ...(kind === "item" ? { financialItemId: targetId } : { debtId: targetId }),
      status,
      explanation: explanation.trim(),
      documentId: documentId || undefined,
      blockerNote: blockerNote.trim() || undefined,
      overrideReason: needsOverride ? overrideReason.trim() : undefined,
    });
  };

  return (
    <Panel as="section" lit className="flex flex-col gap-[18px] p-[26px]">
      {/* A real <h2>: the small-caps
          look is a style, and the heading outline is worth keeping. */}
      <Label as="h2">Een besluit vastleggen</Label>
      <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
        Nu: <span className="font-mono text-ink">{currentStatus}</span>. Een status is een
        stap in het proces, geen oordeel — kies de volgende en schrijf erbij waarom.
      </p>
      <Field label="Volgende status" htmlFor="decision-status">
        <Select id="decision-status" value={status}
          disabled={validNext.isLoading}
          onChange={(e) => setStatus(e.target.value)}>
          <option value="">— kies een status —</option>
          {options.map((s) => (
            <option key={s} value={s}>
              {valid.includes(s) ? s : `${s} (buiten de gebruikelijke route)`}
            </option>
          ))}
        </Select>
      </Field>
      {/* Amber, and rightly so: the form is holding the decision until Martin
          writes down why he is stepping off the usual path. */}
      {needsOverride && (
        <div className="flex flex-col gap-3 rounded-panel border border-attn/30 p-[16px]">
          <p className="text-[13px] font-light leading-relaxed text-ink-soft">
            &quot;{currentStatus}&quot; → &quot;{status}&quot; slaat de gebruikelijke
            stappen over. Dat mag — schrijf alleen even op waarom, dan blijft het
            dossier kloppen.
          </p>
          <Field label="Waarom deze stap klopt" htmlFor="decision-override">
            <Input id="decision-override" value={overrideReason}
              placeholder="bijv. vorige maand al telefonisch opgezegd"
              onChange={(e) => setOverrideReason(e.target.value)} />
          </Field>
        </div>
      )}
      <Field label="Waarom (verplicht — je bent er later blij mee)" htmlFor="decision-why">
        <Textarea id="decision-why" rows={3} value={explanation}
          placeholder="bijv. Dit moet blijven: het is mijn enige internetverbinding."
          onChange={(e) => setExplanation(e.target.value)} />
      </Field>
      <div className="grid gap-[18px] sm:grid-cols-2">
        <Field label="Onderliggend document (optioneel)" htmlFor="decision-document">
          <Select id="decision-document" value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}>
            <option value="">— geen —</option>
            {documents.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
          {/* The list came back full, so there are almost certainly documents
              it does not contain. Saying nothing here would let the picker
              quietly present itself as the whole vault. */}
          {documents.length >= DECISION_PICKER_LIMIT && (
            <p className="mt-[7px] text-[12px] font-light leading-relaxed text-ink-label">
              Alleen de {DECISION_PICKER_LIMIT} nieuwste documenten staan in deze
              lijst. Staat het bestand er niet bij, koppel het dan vanaf het
              document zelf in de kluis.
            </p>
          )}
        </Field>
        <Field label="Wat het tegenhoudt (optioneel)" htmlFor="decision-blocker">
          <Input id="decision-blocker" value={blockerNote}
            placeholder="bijv. aanhouden tot de verhuizing van de mailbox klaar is"
            onChange={(e) => setBlockerNote(e.target.value)} />
        </Field>
      </div>
      {decide.error && (
        <FormError>{decide.error.message}</FormError>
      )}
      <div className="flex pt-1">
        <Button variant="primary" disabled={!ready || decide.isPending} onClick={submit}>
          Besluit vastleggen
        </Button>
      </div>
    </Panel>
  );
}
