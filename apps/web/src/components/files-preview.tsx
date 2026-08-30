import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { buttonClass, Empty, Label, Micro, Panel } from "@/components/ui";

type Caller = Awaited<ReturnType<typeof serverCaller>>;
type DocRow = Awaited<ReturnType<Caller["documents"]["get"]>>;

const NL_STATUS: Record<string, string> = {
  inbox: "Te sorteren", filed: "Opgeborgen", discarded: "Weggelegd",
};

const KB = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
const D = (d: string | Date) => new Date(d).toLocaleDateString("nl-NL", {
  timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit", year: "numeric" });

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-[3px]">
      <Label>{label}</Label>
      <p className="text-[13.5px] font-light text-ink-soft">{value}</p>
    </div>
  );
}

/**
 * The right pane: what it is. A server component — the selection lives in the
 * URL's `sel` param, so this reads whichever document `documents.get` already
 * resolved in the page's own `Promise.all` (or `null` when nothing is picked
 * or the id no longer resolves).
 */
export async function FilesPreview({ doc }: { doc: DocRow | null }) {
  if (!doc) {
    return (
      <Panel className="p-[20px] lg:sticky lg:top-4 lg:self-start">
        <Empty title="Kies een stuk">
          Klik in het midden op een rij om te zien wat het is.
        </Empty>
      </Panel>
    );
  }

  // `documents.get` names the sender only by id; the name lives in `parties`
  // and is looked up here rather than in the page's own Promise.all, so that
  // batch stays exactly the four reads it always was.
  const caller = await serverCaller();
  const partyName = doc.effectivePartyId
    ? (await caller.parties.list()).find((p) => p.id === doc.effectivePartyId)?.name
      ?? "Onbekend"
    : null;

  return (
    <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
      <Panel className="flex flex-col gap-4 p-[20px]">
        <p className="break-words text-[15px] font-light text-ink-bright">
          {doc.effectiveTitle}
        </p>
        <div className="flex flex-col gap-3">
          <Fact label="Soort" value={doc.effectiveDocType ?? "Zonder soort"} />
          <Fact label="Van wie" value={partyName ?? "Onbekend"} />
          <Fact label="Datum" value={D(doc.receivedAt)} />
          <Fact label="Grootte" value={KB(doc.sizeBytes)} />
          <Fact label="Status" value={NL_STATUS[doc.effectiveStatus] ?? doc.effectiveStatus} />
        </div>
        <Micro className="break-all">sha256: {doc.sha256}</Micro>
        <div className="flex flex-wrap gap-2">
          {/*
            `/files/[id]` does not exist until a later task moves the detail
            page here — the plan's own pre-flight calls this pairing clean
            because there is no `typedRoutes` check to catch it. Until then
            this button 404s; the document is still reachable at /vault/<id>.
          */}
          <Link href={`/files/${doc.id}`} className={buttonClass("signal", "sm")}>
            Openen
          </Link>
          <a href={`/api/files/${doc.sha256}`} className={buttonClass("ghost", "sm")}>
            Download
          </a>
        </div>
      </Panel>
    </div>
  );
}
