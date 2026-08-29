"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { TASK_STATUS_ORDER } from "./task-list";
import {
  Button,
  Field,
  FormError,
  Input,
  Panel,
  PanelHead,
  Select,
  Textarea,
} from "@/components/ui";

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
  const uid = useId();
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
    /*
     * The lit panel on the task screen: this is the one thing here that writes
     * to the ledger, and the facts form beside it is an edit, not the point of
     * the visit.
     */
    <Panel lit className="p-[26px]">
      <div className="flex flex-col gap-[18px]">
        <PanelHead labelAs="h2" label="Move it along" />
        <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
          Currently <span className="font-mono text-ink-soft">{currentStatus}</span>.
          {closed
            ? " This one is settled — reopening takes an override, and that's okay too."
            : " A status is a step, not a verdict — pick the next one."}
        </p>
        <Field label="Next status" htmlFor={`${uid}-status`}>
          <Select id={`${uid}-status`} value={status}
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
        {needsOverride && (
          /*
           * Amber outline, no fill: an override is genuinely waiting on Martin
           * (nothing is recorded until he writes the reason), and a solid amber
           * block would shout louder than the marks that carry the same meaning
           * everywhere else in the app.
           */
          <div className="flex flex-col gap-[14px] rounded-panel border border-attn/30 p-[18px]">
            <p className="text-[13.5px] font-light leading-relaxed text-ink-soft">
              &quot;{currentStatus}&quot; → &quot;{status}&quot; skips the usual steps.
              That&apos;s allowed — just write down why, so the record stays honest.
            </p>
            <Field label="Why this jump is right" htmlFor={`${uid}-override`}>
              <Input id={`${uid}-override`} value={overrideReason}
                placeholder="e.g. turned out this was already done last week"
                onChange={(e) => setOverrideReason(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Note (optional — future-you will thank you)" htmlFor={`${uid}-note`}>
          <Textarea id={`${uid}-note`} rows={2} value={note}
            placeholder="e.g. Sent the documents, waiting for confirmation."
            onChange={(e) => setNote(e.target.value)} />
        </Field>
        {setTaskStatus.error && (
          <FormError>
            {setTaskStatus.error.message}
          </FormError>
        )}
        <div>
          <Button variant="primary" disabled={!ready || setTaskStatus.isPending} onClick={submit}>
            Record status change
          </Button>
        </div>
      </div>
    </Panel>
  );
}
