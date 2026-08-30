import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";
import { buildFilesHref, encodeBranch, type Branch, type ParsedFiles } from "@/lib/files-url";

const NL_SOURCE: Record<string, string> = {
  upload: "Geüpload", "nas-scan": "Gescand", "email-attachment": "Uit de mail",
};
const NL_STATUS: Record<string, string> = {
  inbox: "Te sorteren", filed: "Opgeborgen", discarded: "Weggelegd",
};

// The narrow slices of `Branch` that carry a value pulled straight off the
// database — casting through these (rather than through `any`/`never`) keeps
// the assertion visible and typed: the tree trusts the rows it groups on to
// already be one of the values the enum admits, because both come from the
// same columns `documents.tree`'s SQL reads.
type BronSource = Extract<Branch, { kind: "bron" }>["source"];
type DocStatus = Extract<Branch, { kind: "status" }>["status"];

/**
 * The exact shape `documents.tree` (Task 5) returns — declared here rather
 * than derived through a `RouterOutputs` helper, because no such helper
 * exists anywhere under `apps/web/src/lib`. See Ruling 4.
 */
export interface FilesTreeData {
  soort: { key: string; label: string; n: number }[];
  vanWie: { partyId: string | null; name: string; n: number }[];
  periode: { month: string; label: string; n: number }[];
  bron: { source: string; n: number }[];
  status: { status: string; n: number }[];
}

export interface FilesTreeProps {
  tree: FilesTreeData;
  bundles: { id: string; name: string; count: number; kind: string }[];
  parsed: ParsedFiles;
}

/**
 * The left pane: what you narrow by. A server component, links only — every
 * branch is a URL, so a link Martin sends himself reproduces exactly this
 * view (the same rule /search follows).
 */
export function FilesTree({ tree, bundles, parsed }: FilesTreeProps) {
  const Item = ({ branch, label, n }: { branch: Branch; label: string; n: number }) => {
    const on = encodeBranch(branch) === encodeBranch(parsed.branch);
    return (
      <Link href={buildFilesHref(parsed, { branch, sel: "" })}
        className={cx("flex items-baseline justify-between gap-2 py-[3px] text-[12.5px] transition-colors",
          on ? "text-signal" : "text-ink-mute hover:text-ink-soft")}>
        <span className="truncate">{label}</span>
        <span className="micro shrink-0">{n}</span>
      </Link>
    );
  };
  const Group = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="flex flex-col gap-[3px]">
      <p className="lbl mb-[5px]">{label}</p>
      {children}
    </div>
  );

  return (
    <nav aria-label="Filters" className="flex flex-col gap-5 lg:sticky lg:top-4 lg:self-start">
      <Group label="bundels">
        {bundles.map((b) => (
          <Item key={b.id} branch={{ kind: "bundel", id: b.id }} label={b.name} n={b.count} />
        ))}
        <Link href={buildFilesHref(parsed, { branch: { kind: "bundels" }, sel: "" })}
          className="py-[3px] text-[12.5px] text-signal transition-colors hover:text-signal-link">
          Alle bundels →
        </Link>
      </Group>

      <Group label="soort">
        {tree.soort.map((s) => (
          <Item key={s.key || "geen"} branch={{ kind: "soort", key: s.key }}
            label={s.label || "Zonder soort"} n={s.n} />
        ))}
      </Group>

      <Group label="van wie">
        {tree.vanWie.map((v) => (
          <Item key={v.partyId ?? "onbekend"} branch={{ kind: "party", id: v.partyId }}
            label={v.name} n={v.n} />
        ))}
      </Group>

      <Group label="periode">
        {tree.periode.map((p) => (
          <Item key={p.month} branch={{ kind: "periode", month: p.month }}
            label={p.label} n={p.n} />
        ))}
      </Group>

      <Group label="bron">
        {tree.bron.map((b) => (
          <Item key={b.source} branch={{ kind: "bron", source: b.source as BronSource }}
            label={NL_SOURCE[b.source] ?? b.source} n={b.n} />
        ))}
      </Group>

      <Group label="status">
        {tree.status.map((s) => (
          <Item key={s.status} branch={{ kind: "status", status: s.status as DocStatus }}
            label={NL_STATUS[s.status] ?? s.status} n={s.n} />
        ))}
      </Group>
    </nav>
  );
}
