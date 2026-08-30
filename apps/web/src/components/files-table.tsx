"use client";
import { useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import {
  Micro, Panel, Select, Table, TableWrap, Td, Th, buttonClass,
} from "@/components/ui";
import { buildFilesHref, type ParsedFiles, type Sort } from "@/lib/files-url";
import { nextSelection } from "@/lib/files-selection";

type Row = {
  id: string; title: string; docType: string | null; partyName: string | null;
  receivedAt: string | Date; sizeBytes: number; status: string;
};

const KB = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
const D = (d: string | Date) => new Date(d).toLocaleDateString("nl-NL", {
  timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit", year: "numeric" });

const HEADS: { sort: Sort; label: string; right?: boolean }[] = [
  { sort: "naam", label: "Naam" }, { sort: "soort", label: "Soort" },
  { sort: "van", label: "Van" }, { sort: "datum", label: "Datum" },
  { sort: "grootte", label: "Grootte", right: true },
];

/**
 * A `<select>` of manual bundles plus a button — the one write action this
 * pane has. Rule bundles never appear here: `bundles.addDocuments` refuses
 * them (they follow a rule, not a hand-picked list), so `page.tsx` only ever
 * hands this component the manual ones.
 */
function AddToBundle({ ids, bundles, onDone }: {
  ids: string[];
  bundles: { id: string; name: string }[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [bundleId, setBundleId] = useState(bundles[0]?.id ?? "");
  const add = trpc.bundles.addDocuments.useMutation({
    onSuccess: () => { onDone(); router.refresh(); },
  });
  return (
    <span className="flex items-center gap-2">
      <Select aria-label="Bundel" value={bundleId} disabled={add.isPending}
        onChange={(e) => setBundleId(e.target.value)}
        className="w-auto py-[7px] text-[11.5px]">
        {bundles.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </Select>
      <button type="button" disabled={!bundleId || add.isPending}
        onClick={() => bundleId && add.mutate({ id: bundleId, documentIds: ids })}
        className={buttonClass("ghost", "sm")}>
        Aan bundel toevoegen
      </button>
    </span>
  );
}

export function FilesTable({ rows, total, parsed, bundles }: {
  rows: Row[]; total: number; parsed: ParsedFiles;
  bundles: { id: string; name: string }[];
}) {
  // Selection is client state on purpose: a sixty-item selection in a query
  // string is a URL nobody can share anyway. `last` carries the anchor for a
  // shift-click range. The reducer itself lives in files-selection.ts, pure
  // and unit-tested, so this component only has to wire the DOM event to it.
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [last, setLast] = useState<number | null>(null);
  const ids = rows.map((r) => r.id);

  const toggle = (i: number, shift: boolean) => {
    setSel((prev) => nextSelection(prev, ids, i, last, shift));
    setLast(i);
  };

  // `shiftKey` is an undocumented detail of the underlying event, not a
  // guaranteed property of every ChangeEvent — a mouse click carries it
  // because React's checkbox onChange rides the native click, but keyboard
  // activation (Tab + Space) and assistive tech have no such property.
  // Reading it unconditionally would be a blind cast; its absence must
  // degrade to a single-row toggle, never to a guessed range.
  const shiftHeld = (e: ChangeEvent<HTMLInputElement>): boolean => {
    const ne = e.nativeEvent;
    return "shiftKey" in ne && Boolean((ne as MouseEvent).shiftKey);
  };

  return (
    <Panel lit className="flex min-w-0 flex-col gap-3 p-[20px]">
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th className="w-[22px]" />
              {HEADS.map((h) => (
                <Th key={h.sort} className={h.right ? "text-right" : undefined}>
                  <Link
                    href={buildFilesHref(parsed, { sort: h.sort,
                      dir: parsed.sort === h.sort && parsed.dir === "desc" ? "asc" : "desc" })}
                    className={parsed.sort === h.sort ? "text-signal" : "hover:text-ink-mute"}>
                    {h.label}{parsed.sort === h.sort ? (parsed.dir === "asc" ? " ↑" : " ↓") : ""}
                  </Link>
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className={sel.has(r.id) ? "bg-signal/8" : undefined}>
                <Td>
                  <input type="checkbox" checked={sel.has(r.id)}
                    aria-label={`Selecteer ${r.title}`}
                    onChange={(e) => toggle(i, shiftHeld(e))} />
                </Td>
                <Td>
                  <Link href={buildFilesHref(parsed, { sel: r.id })}
                    className="transition-colors hover:text-signal">{r.title}</Link>
                </Td>
                <Td className="text-ink-mute">{r.docType ?? "—"}</Td>
                <Td className="text-ink-mute">{r.partyName ?? "—"}</Td>
                <Td className="font-mono text-[10px] tracking-[0.1em] text-ink-dim">{D(r.receivedAt)}</Td>
                <Td className="text-right font-mono text-[10px] tracking-[0.1em] text-ink-dim">{KB(r.sizeBytes)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>

      {/* The vault's law: a list that simply stops is indistinguishable from a
          document that was never filed. */}
      {total > rows.length && (
        <Micro>de {rows.length} van {total} — verfijn links, of zoek via ⌘K</Micro>
      )}
      {rows.length === 0 && (
        <p className="py-3 text-[13px] font-light text-ink-mute">
          Niets in deze tak. Kies links iets anders.
        </p>
      )}

      {sel.size > 0 && (
        // A form POST and not fetch+blob: it streams, the browser shows its own
        // progress, and it works with JavaScript disabled once rendered.
        <form action="/api/files/zip" method="POST"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[3px] border border-signal/25 bg-signal/5 px-[14px] py-[10px]">
          {[...sel].map((id) => <input key={id} type="hidden" name="id" value={id} />)}
          <span className="text-[12.5px] text-ink-soft">{sel.size} geselecteerd</span>
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => setSel(new Set())}
              className={buttonClass("ghost", "sm")}>Wis selectie</button>
            {bundles.length > 0 && (
              <AddToBundle ids={[...sel]} bundles={bundles} onDone={() => setSel(new Set())} />
            )}
            <button type="submit" className={buttonClass("primary", "sm")}>Download .zip</button>
          </span>
        </form>
      )}
    </Panel>
  );
}
