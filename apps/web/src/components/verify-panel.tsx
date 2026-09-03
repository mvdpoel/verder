"use client";
import { useId, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button, buttonClass, Callout, Field, Input, Label, Panel } from "@/components/ui";

export function VerifyPanel() {
  const run = trpc.verify.run.useMutation();
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  // The two date inputs had no labels at all. `Field` puts one above every
  // control, and a label only works when it points at its input — hence the ids.
  const fromId = useId();
  const toId = useId();
  const rangeIncomplete = !from || !to;
  return (
    <div className="flex flex-col gap-6">
      {/*
        The lit panel — one per screen. On /verify the chain check IS the screen,
        so it takes the streak and the single primary button, and the search
        index card beside it stays deliberately quiet.
      */}
      <Panel lit>
        <div className="flex flex-col gap-4 p-[26px]">
          <Label as="h2">Integriteitscontrole</Label>
          <p className="max-w-prose text-[13.5px] font-light leading-relaxed text-ink-mute">
            Herberekent elke hash in de keten en leest elk opgeslagen bestand opnieuw.
          </p>
          <div>
            <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? "Bezig met controleren…" : "Controle uitvoeren"}
            </Button>
          </div>
          {/*
            No result is dressed as fine before it is: nothing renders here until
            the mutation has answered, and the failing branch is amber because a
            broken chain is the one thing on this page that genuinely waits on
            Martin — it says so itself ("investigate before writing anything new").
            The ✔ / ✘ the copy already carries is the marker; a Dot beside it
            would say the same thing twice.
          */}
          {run.data && (run.data.ok
            ? (
              <Callout tone="ok" className="flex-col gap-[9px]">
                <p className="text-[13.5px] font-light leading-relaxed text-okay">
                  ✔ Alles klopt. <span className="font-mono">{run.data.count}</span> gebeurtenissen gecontroleerd, <span className="font-mono">{run.data.checkedFiles}</span> bestanden opnieuw gehasht{run.data.purgedFiles > 0 && <>, <span className="font-mono">{run.data.purgedFiles}</span> definitief verwijderd</>}.
                  {run.data.purgedFilesOnDisk > 0 && <> <span className="text-attn">{run.data.purgedFilesOnDisk} daarvan staan nog op schijf — verwijder ze opnieuw.</span></>}
                </p>
                <p className="break-all font-mono text-[11px] leading-relaxed tracking-[0.04em] text-ink-dim">
                  Kop van de keten: <span className="text-okay">{run.data.headHash}</span>
                </p>
              </Callout>
            )
            : (
              <Callout tone="attn">
                <p className="text-[13.5px] font-light leading-relaxed text-attn">
                  ✘ De keten is gebroken bij gebeurtenis <span className="font-mono">{run.data.brokenAtSeq}</span> (<span className="font-mono">{run.data.reason}</span>). Geen paniek — er is niets kwijt; zoek dit uit vóór je iets nieuws vastlegt.
                </p>
              </Callout>
            ))}
        </div>
      </Panel>

      <Panel>
        <div className="flex flex-col gap-4 p-[26px]">
          <Label as="h2">Overzicht exporteren</Label>
          <div className="grid max-w-sm grid-cols-2 gap-4">
            <Field label="Van" htmlFor={fromId}>
              <Input id={fromId} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Tot en met" htmlFor={toId}>
              <Input id={toId} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <div>
            {/*
              A link that looks like a button, so the report opens in its own tab
              without a <button> nested in an <a>. `buttonClass`'s disabled
              styling only reaches a real <button>, so the half-filled range is
              spelled out here — and announced, not just greyed.
            */}
            <a
              className={buttonClass("ghost", "md", rangeIncomplete ? "pointer-events-none opacity-50" : undefined)}
              aria-disabled={rangeIncomplete || undefined}
              href={`/verify/export?from=${from}&to=${to}`}
              target="_blank"
              rel="noreferrer"
            >Overzicht openen (printen → pdf)</a>
          </div>
        </div>
      </Panel>
    </div>
  );
}
