"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { Button, Field, Input, FormError, Micro } from "@/components/ui";

/**
 * Definitief verwijderen: two-step, the shape BundleCardActions already uses.
 *
 * `danger`, not `signal`, for the reason button.tsx records — bordered amber is
 * the system's voice for "something you only want to do on purpose", while
 * `signal` reads as "this is the one to press", which is the wrong voice for a
 * destructive confirm.
 */
export function DocumentPurge({ doc }: { doc: { id: string } }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const purge = trpc.documents.purge.useMutation({ onSuccess: () => router.refresh() });

  // Mirrors BundleCardActions' openDeleteConfirm: without the reset, a failed
  // attempt followed by "annuleren" and a second click shows the previous
  // error before this one has done anything.
  function open() { purge.reset(); setReason(""); setConfirming(true); }

  if (!confirming) {
    return (
      <div className="flex flex-col items-start gap-[10px] border-t border-hairline pt-5">
        <Button variant="ghost" onClick={open}>Definitief verwijderen</Button>
        <Micro>Het bestand zelf wordt vernietigd. Dit kan niet ongedaan worden gemaakt.</Micro>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-[10px] border-t border-hairline pt-5">
      <Micro>
        Het bestand, de uitgelezen tekst en de zoekresultaten worden vernietigd.
        De regel in het logboek blijft staan, met deze aantekening erbij.
        Dit kan niet ongedaan worden gemaakt.
      </Micro>
      <Field label="Reden (mag leeg)" htmlFor="purge-reason" className="w-full">
        <Input id="purge-reason" value={reason} placeholder="bijvoorbeeld: per ongeluk gescand"
          onChange={(e) => setReason(e.target.value)} />
      </Field>
      {purge.error && <FormError>{purge.error.message}</FormError>}
      <div className="flex gap-2">
        <Button variant="quiet" onClick={() => setConfirming(false)}>Annuleren</Button>
        <Button variant="danger" disabled={purge.isPending}
          onClick={() => purge.mutate({ id: doc.id, reason: reason.trim() || undefined })}>
          Ja, definitief verwijderen
        </Button>
      </div>
    </div>
  );
}

/**
 * The repair path for a purge whose unlink failed. The mutation is a no-op on
 * the record (the first reason stands) and still retries the unlink, which is
 * exactly what is needed here.
 */
export function DocumentPurgeRetry({ id }: { id: string }) {
  const router = useRouter();
  const purge = trpc.documents.purge.useMutation({ onSuccess: () => router.refresh() });
  return (
    <Button variant="danger" disabled={purge.isPending}
      onClick={() => purge.mutate({ id })}>Opnieuw verwijderen</Button>
  );
}
