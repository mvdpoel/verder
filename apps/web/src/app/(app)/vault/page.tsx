import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { UploadDrop } from "@/components/upload-drop";
import { Empty, Label, Micro, PageTitle, Panel, Row, type DotState } from "@/components/ui";

/**
 * One page of documents per section.
 *
 * The lists are capped and the HEADINGS ARE NOT: they count with
 * `documents.counts`, which asks the database rather than measuring the page it
 * was just handed. Before this, "Postvak — 100 te sorteren" was what a vault of
 * 100 documents and a vault of 1000 both said, and the missing 900 were not
 * mentioned anywhere on the screen.
 */
const VAULT_PAGE = 100;

export default async function VaultPage() {
  const caller = await serverCaller();
  // Four independent reads. They used to run one after another, so the page
  // waited on four full round trips before it drew anything at all.
  const [inbox, filed, discarded, counts] = await Promise.all([
    caller.documents.list({ status: "inbox", limit: VAULT_PAGE }),
    caller.documents.list({ status: "filed", limit: VAULT_PAGE }),
    // The way back from a mistake. Without a surface that lists them, a document
    // discarded in error is reachable only by typing its UUID — the Undo button
    // exists but is unreachable for anything Martin cannot already name.
    caller.documents.list({ status: "discarded", limit: VAULT_PAGE }),
    caller.documents.counts(),
  ]);

  /**
   * One document.
   *
   * `Row as="li"`, so the rows are the list's own children and the hairline it
   * draws under all but the last one lands where it is meant to. The list stays
   * a real <ul>/<li> because that is what tells a screen reader how many
   * documents there are.
   *
   * The dot follows the app's legend and deliberately never turns amber: a
   * document in the inbox is a stop still running (cyan ring), not a deadline —
   * the heading already says there is no rush.
   */
  const DocRow = ({ d, state }: { d: (typeof inbox)[number]; state: DotState }) => (
    <Row
      as="li"
      state={state}
      title={
        <Link
          href={`/vault/${d.id}`}
          className="text-ink-soft transition-colors hover:text-signal">
          {d.effectiveTitle}
        </Link>
      }
      kicker={`${d.effectiveDocType ?? d.mime} · ${(d.sizeBytes / 1024).toFixed(0)} KB · ${d.source}`}
    />
  );

  /**
   * Said out loud whenever a section shows fewer documents than it has.
   *
   * The alternative — a list that simply stops — is the one thing a vault may
   * never do: its entire promise is that nothing goes missing, and a silent
   * truncation is indistinguishable from a document that was never filed.
   */
  const Truncated = ({ shown, total }: { shown: number; total: number }) =>
    total > shown ? (
      <Micro className="mt-[10px]">
        de {shown} nieuwste van {total} — zoek de rest via ⌘K of{" "}
        <Link href="/search" className="text-signal transition-colors hover:text-signal-link">
          zoeken
        </Link>
      </Micro>
    ) : null;

  return (
    <div className="flex flex-col gap-8">
      <PageTitle>Kluis</PageTitle>
      <UploadDrop />
      <Panel lit className="p-[26px]">
        <Label as="h2">
          Postvak — {counts.inbox ? `${counts.inbox} te sorteren, geen haast` : "alles gesorteerd, netjes gedaan ✨"}
        </Label>
        {inbox.length > 0 && (
          <ul className="mt-[10px]">
            {inbox.map((d) => <DocRow key={d.id} d={d} state="open" />)}
          </ul>
        )}
        <Truncated shown={inbox.length} total={counts.inbox} />
      </Panel>
      <Panel className="p-[26px]">
        <Label as="h2">Opgeborgen — {counts.filed}</Label>
        {/* This had no empty state at all: a fresh dossier drew the heading over
            nothing, which reads as a list that failed to load. */}
        {filed.length === 0 ? (
          <div className="mt-[14px]">
            <Empty title="Nog niets opgeborgen">
              Zodra je een document uit het postvak een naam en een soort geeft,
              staat het hier.
            </Empty>
          </div>
        ) : (
          <ul className="mt-[10px]">
            {filed.map((d) => <DocRow key={d.id} d={d} state="done" />)}
          </ul>
        )}
        <Truncated shown={filed.length} total={counts.filed} />
      </Panel>
      {counts.discarded > 0 && (
        <Panel className="p-[26px]">
          {/*
            Collapsed, but never hidden: this section is the only route back to a
            document discarded by mistake. Hence the marker is replaced by a
            chevron that turns — a <summary> that does not look openable is the
            same as no section at all.
          */}
          <details className="group">
            <summary className="lbl flex cursor-pointer list-none items-center gap-[10px] text-ink-mute transition-colors hover:text-ink-soft [&::-webkit-details-marker]:hidden">
              <svg
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                className="shrink-0 transition-transform group-open:rotate-90"
                aria-hidden="true"
              >
                <path d="M9 5l7 7-7 7" />
              </svg>
              Weggelegd — {counts.discarded} blijven in de kluis, verder overal verborgen
            </summary>
            <p className="mt-[14px] text-[13px] font-light leading-relaxed text-ink-mute">
              Er is hier niets verwijderd. Open er een om het terug te zetten.
            </p>
            <ul className="mt-[6px]">
              {discarded.map((d) => <DocRow key={d.id} d={d} state="waiting" />)}
            </ul>
            <Truncated shown={discarded.length} total={counts.discarded} />
          </details>
        </Panel>
      )}
    </div>
  );
}
