"use client";
import Link from "next/link";
import { buttonClass, Button, Micro, Panel, PageTitle } from "@/components/ui";

/**
 * Something broke while building a page.
 *
 * This boundary sits INSIDE the (app) group on purpose, so the rail and the top
 * bar stay put: whatever failed, Martin is still somewhere in his own dossier
 * and can walk out of it. Next's default page replaces the entire document with
 * "Application error: a server-side exception has occurred" — English,
 * unstyled, no way back — which for a dossier whose whole promise is that the
 * record holds is the worst possible thing to show.
 *
 * IT SAYS NOTHING IS LOST, and that is the load-bearing sentence. Every write in
 * this app is an append to a hash-chained ledger; a page that fails to RENDER
 * has not touched it. Someone who has just been told his dossier crashed needs
 * to know that before he needs anything else.
 *
 * NOT AMBER. Amber means "waiting on Martin", and a crash is not his to fix —
 * `digest` is here because the fix happens in the worker logs on the homelab,
 * and that is the string that finds it.
 */
export default function AppError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageTitle>Daar ging iets mis</PageTitle>
      <Panel className="flex flex-col gap-5 p-[26px]">
        <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
          Deze pagina kon niet worden opgebouwd. Er is niets kwijt en er is niets
          veranderd — het dossier zelf staat er nog precies zo bij als daarnet.
          Probeer het opnieuw; blijft het misgaan, dan ligt het aan de server en
          niet aan jou.
        </p>
        <div className="flex flex-wrap items-center gap-[10px]">
          {/* `reset` re-renders the segment. It is the primary action because it
              is the one that usually works: most of these are a query that
              timed out, not a page that can never load. */}
          <Button variant="primary" onClick={reset}>Opnieuw proberen</Button>
          <Link className={buttonClass("ghost")} href="/dashboard">Naar het dashboard</Link>
        </div>
        {error.digest && (
          <Micro className="break-all border-t border-hairline pt-[14px]">
            foutcode {error.digest}
          </Micro>
        )}
      </Panel>
    </div>
  );
}
