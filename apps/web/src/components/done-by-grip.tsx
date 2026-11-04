"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import type { GripActionDTO } from "@grip/api/src/routers/grip-actions";
import { gripActionChanges, gripActionHeadline, gripActionNote } from "@/lib/grip-action-copy";
import { Button, FormError, Label, Micro, Panel, TextLink } from "@/components/ui";

const D = (iso: string) => new Date(iso).toLocaleString("nl-NL", {
  timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * "Door verder gedaan" (spec §6.6): what verder changed on its own in the last
 * week, each with a one-tap undo.
 *
 * NEVER AMBER. Everything here is already done; it is there to check, not
 * waiting on Martin — so it sits below the cards, closed by default, and the
 * only amber it may show is a form error (the documented exception).
 *
 * The undo appends a correction in Martin's name through the append-only
 * change table (routers/grip-actions.ts); a refusal ("al aangepast",
 * "vernietigd") is shown as the server said it and the list is refreshed.
 */
export function DoneByGrip({ actions }: { actions: GripActionDTO[] }) {
  if (actions.length === 0) return null;
  return (
    <details className="group">
      <summary className="cursor-pointer list-none">
        <Label as="h2" className="transition-colors group-hover:text-signal">
          Door verder gedaan · {actions.length}
        </Label>
      </summary>
      <ul className="mt-4 flex flex-col gap-3">
        {actions.map((a) => <DoneRow key={a.changeId} a={a} />)}
      </ul>
    </details>
  );
}

function DoneRow({ a }: { a: GripActionDTO }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const undo = trpc.gripActions.undo.useMutation({
    onSuccess: () => router.refresh(),
    onError: (e) => { setError(e.message); router.refresh(); },
  });
  const note = gripActionNote(a);
  return (
    <Panel as="li">
      <div className="flex flex-col gap-2 p-[18px]">
        <Micro>{gripActionHeadline(a)} · {D(a.at)}</Micro>
        <TextLink href={`/files/${a.documentId}`} className="text-sm">
          {a.documentTitle ?? "Document"}
        </TextLink>
        {gripActionChanges(a).map((line) => (
          <p key={line} className="font-mono text-[11px] tracking-[0.06em] text-ink-soft">{line}</p>
        ))}
        {a.kind === "auto-file" && a.proposedTitle && a.proposedTitle !== a.documentTitle ? (
          <p className="text-xs font-light text-ink-dim">Voorgestelde naam (niet toegepast): {a.proposedTitle}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button variant="ghost" size="sm" disabled={!a.undoable || undo.isPending}
            onClick={() => { setError(null); undo.mutate({ changeId: a.changeId }); }}>
            Ongedaan maken
          </Button>
          {note ? <span className="text-xs font-light text-ink-dim">{note}</span> : null}
        </div>
        {error ? <FormError>{error}</FormError> : null}
      </div>
    </Panel>
  );
}
