"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { DEBT_STATUS_ORDER, ITEM_STATUS_ORDER } from "./registry-list";

/**
 * Records a status decision for an item or debt. The next status is
 * constrained to the valid transitions from the current status
 * (registry.validNext); picking any other status is still possible but
 * switches the form into the override path — the reason is then part of
 * the record. Every decision lands in the ledger; nothing is ever erased.
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
    <section className="rounded border bg-white p-4 space-y-3">
      <h2 className="font-semibold">Record a decision</h2>
      <p className="text-sm text-slate-600">
        Currently <span className="font-medium">{currentStatus}</span>. A status is a
        step in the process, not a verdict — pick the next one and say why.
      </p>
      <label className="block text-sm">Next status
        <select className="w-full border rounded p-2" value={status}
          disabled={validNext.isLoading}
          onChange={(e) => setStatus(e.target.value)}>
          <option value="">— pick a status —</option>
          {options.map((s) => (
            <option key={s} value={s}>
              {valid.includes(s) ? s : `${s} (off the usual path)`}
            </option>
          ))}
        </select></label>
      {needsOverride && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2">
          <p className="text-sm">
            &quot;{currentStatus}&quot; → &quot;{status}&quot; skips the usual steps.
            That&apos;s allowed — just write down why, so the record stays honest.
          </p>
          <label className="block text-sm">Why this jump is right
            <input className="w-full border rounded p-2" value={overrideReason}
              placeholder="e.g. already canceled by phone last month"
              onChange={(e) => setOverrideReason(e.target.value)} /></label>
        </div>
      )}
      <label className="block text-sm">Why (required — future-you will thank you)
        <textarea className="w-full border rounded p-2" rows={3} value={explanation}
          placeholder="e.g. This has to stay: it's my only internet connection."
          onChange={(e) => setExplanation(e.target.value)} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">Supporting document (optional)
          <select className="w-full border rounded p-2" value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}>
            <option value="">— none —</option>
            {documents.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </select></label>
        <label className="block text-sm">Blocker note (optional)
          <input className="w-full border rounded p-2" value={blockerNote}
            placeholder="e.g. keep until mailbox migration is done"
            onChange={(e) => setBlockerNote(e.target.value)} /></label>
      </div>
      {decide.error && (
        <p className="text-sm text-red-600">{decide.error.message}</p>
      )}
      <button className="rounded bg-slate-900 text-white px-6 py-2 disabled:opacity-50"
        disabled={!ready || decide.isPending} onClick={submit}>
        Record decision
      </button>
    </section>
  );
}
