import Link from "next/link";
import { buttonClass, Panel, PageTitle } from "@/components/ui";

/**
 * The record behind this URL is not there.
 *
 * Reached through `orNotFound` in `lib/not-found.ts`, which turns the routers'
 * NOT_FOUND into this page instead of a crash. The distinction is worth a whole
 * page: "this document does not exist" is an answer, and "the app fell over" is
 * not, and before this they looked identical.
 *
 * The copy deliberately names the innocent explanations first. In a dossier
 * that runs on hash-chained evidence, "your document is missing" reads as an
 * accusation unless you say in the same breath that a discarded file is still
 * in the vault and a stale link is just a stale link.
 */
export default function AppNotFound() {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageTitle>Dit bestaat niet (meer)</PageTitle>
      <Panel className="flex flex-col gap-5 p-[26px]">
        <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
          Op dit adres staat niets. Meestal komt dat door een oude link of een
          typefout in het webadres — er is niets verwijderd: in dit dossier wordt
          nooit iets weggegooid, ook een weggelegd document blijft in de kluis
          staan.
        </p>
        <div className="flex flex-wrap items-center gap-[10px]">
          <Link className={buttonClass("primary")} href="/dashboard">Naar het dashboard</Link>
          <Link className={buttonClass("ghost")} href="/search">Zoeken in het dossier</Link>
        </div>
      </Panel>
    </div>
  );
}
