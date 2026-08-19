"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { TASK_STATUS_ORDER } from "./task-list";

/**
 * Moves a task to its next status. The select is constrained to the valid
 * transitions from the current status (tasks.validNext); picking any other
 * status is still possible but switches the form into the override path —
 * the reason is then part of the record. Every change lands in the ledger;
 * nothing is ever erased. Mirrors decision-form.tsx.
 */
export function TaskStatusForm({ taskId, currentStatus }: {
  taskId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const validNext = trpc.tasks.validNext.useQuery({ from: currentStatus });
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const setTaskStatus = trpc.tasks.setStatus.useMutation({
    onSuccess: () => {
      setStatus(""); setNote(""); setOverrideReason("");
      router.refresh();
    },
  });

  const valid: string[] = validNext.data ?? [];
  const options = TASK_STATUS_ORDER.filter((s) => s !== currentStatus);
  const needsOverride = status !== "" && !valid.includes(status);
  const ready = status !== "" && (!needsOverride || overrideReason.trim() !== "");
  const closed = valid.length === 0;

  const submit = () => {
    if (!ready) return;
    setTaskStatus.mutate({
      taskId,
      status: status as (typeof TASK_STATUS_ORDER)[number],
      note: note.trim() || undefined,
      overrideReason: needsOverride ? overrideReason.trim() : undefined,
    });
  };

  return (
    <section className="rounded border bg-white p-4 space-y-3">
      <h2 className="font-semibold">Move it along</h2>
      <p className="text-sm text-slate-600">
        Currently <span className="font-medium">{currentStatus}</span>.
        {closed
          ? " This one is settled — reopening takes an override, and that's okay too."
          : " A status is a step, not a verdict — pick the next one."}
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
              placeholder="e.g. turned out this was already done last week"
              onChange={(e) => setOverrideReason(e.target.value)} /></label>
        </div>
      )}
      <label className="block text-sm">Note (optional — future-you will thank you)
        <textarea className="w-full border rounded p-2" rows={2} value={note}
          placeholder="e.g. Sent the documents, waiting for confirmation."
          onChange={(e) => setNote(e.target.value)} /></label>
      {setTaskStatus.error && (
        <p className="text-sm text-red-600">{setTaskStatus.error.message}</p>
      )}
      <button className="rounded bg-slate-900 text-white px-6 py-2 disabled:opacity-50"
        disabled={!ready || setTaskStatus.isPending} onClick={submit}>
        Record status change
      </button>
    </section>
  );
}
