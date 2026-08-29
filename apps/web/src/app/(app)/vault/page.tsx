import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { UploadDrop } from "@/components/upload-drop";
import { Label, PageTitle, Panel, Row, type DotState } from "@/components/ui";

export default async function VaultPage() {
  const caller = await serverCaller();
  const inbox = await caller.documents.list({ status: "inbox", limit: 100 });
  const filed = await caller.documents.list({ status: "filed", limit: 100 });
  // The way back from a mistake. Without a surface that lists them, a document
  // discarded in error is reachable only by typing its UUID — the Undo button
  // exists but is unreachable for anything Martin cannot already name.
  const discarded = await caller.documents.list({ status: "discarded", limit: 100 });
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
   * the heading already says "no rush".
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

  return (
    <div className="flex flex-col gap-8">
      <PageTitle>Vault</PageTitle>
      <UploadDrop />
      <Panel lit className="p-[26px]">
        <Label as="h2">Inbox — {inbox.length ? `${inbox.length} to sort, no rush` : "all sorted, nice work ✨"}</Label>
        <ul className="mt-[10px]">
          {inbox.map((d) => <DocRow key={d.id} d={d} state="open" />)}
        </ul>
      </Panel>
      <Panel className="p-[26px]">
        <Label as="h2">Filed documents</Label>
        <ul className="mt-[10px]">
          {filed.map((d) => <DocRow key={d.id} d={d} state="done" />)}
        </ul>
      </Panel>
      {discarded.length > 0 && (
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
              Discarded — {discarded.length} kept in the vault, hidden everywhere else
            </summary>
            <p className="mt-[14px] text-[13px] font-light leading-relaxed text-ink-mute">
              Nothing here was deleted. Open one to undo the discard.
            </p>
            <ul className="mt-[6px]">
              {discarded.map((d) => <DocRow key={d.id} d={d} state="waiting" />)}
            </ul>
          </details>
        </Panel>
      )}
    </div>
  );
}
