"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { DEBT_STATUS_ORDER, ITEM_STATUS_ORDER } from "./registry-list";
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
      <Label as="h2">Record a decision</Label>
      <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
        Currently <span className="font-mono text-ink">{currentStatus}</span>. A status is a
        step in the process, not a verdict — pick the next one and say why.
      </p>
      <Field label="Next status" htmlFor="decision-status">
        <Select id="decision-status" value={status}
          disabled={validNext.isLoading}
          onChange={(e) => setStatus(e.target.value)}>
          <option value="">— pick a status —</option>
          {options.map((s) => (
            <option key={s} value={s}>
              {valid.includes(s) ? s : `${s} (off the usual path)`}
            </option>
          ))}
        </Select>
      </Field>
      {/* Amber, and rightly so: the form is holding the decision until Martin
          writes down why he is stepping off the usual path. */}
      {needsOverride && (
        <div className="flex flex-col gap-3 rounded-panel border border-attn/30 p-[16px]">
          <p className="text-[13px] font-light leading-relaxed text-ink-soft">
            &quot;{currentStatus}&quot; → &quot;{status}&quot; skips the usual steps.
            That&apos;s allowed — just write down why, so the record stays honest.
          </p>
          <Field label="Why this jump is right" htmlFor="decision-override">
            <Input id="decision-override" value={overrideReason}
              placeholder="e.g. already canceled by phone last month"
              onChange={(e) => setOverrideReason(e.target.value)} />
          </Field>
        </div>
      )}
      <Field label="Why (required — future-you will thank you)" htmlFor="decision-why">
        <Textarea id="decision-why" rows={3} value={explanation}
          placeholder="e.g. This has to stay: it's my only internet connection."
          onChange={(e) => setExplanation(e.target.value)} />
      </Field>
      <div className="grid gap-[18px] sm:grid-cols-2">
        <Field label="Supporting document (optional)" htmlFor="decision-document">
          <Select id="decision-document" value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}>
            <option value="">— none —</option>
            {documents.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </Select>
        </Field>
        <Field label="Blocker note (optional)" htmlFor="decision-blocker">
          <Input id="decision-blocker" value={blockerNote}
            placeholder="e.g. keep until mailbox migration is done"
            onChange={(e) => setBlockerNote(e.target.value)} />
        </Field>
      </div>
      {decide.error && (
        <FormError>{decide.error.message}</FormError>
      )}
      <div className="flex pt-1">
        <Button variant="primary" disabled={!ready || decide.isPending} onClick={submit}>
          Record decision
        </Button>
      </div>
    </Panel>
  );
}
