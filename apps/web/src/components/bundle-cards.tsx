import { describeRule } from "@verder/api/src/bundle-rule";
import { serverCaller } from "@/lib/trpc-server";
import { Empty, Label, Micro, Notice, Panel, buttonClass } from "@/components/ui";
import { BundleCardActions, BundleForm } from "@/components/bundle-form";

type Caller = Awaited<ReturnType<typeof serverCaller>>;
export type BundleRow = Awaited<ReturnType<Caller["bundles"]["list"]>>[number];

/**
 * The `bundels` view: one card per bundle, plus the one card in the grid
 * that is an action rather than a thing — "Nieuwe bundel", which opens
 * `BundleForm`. Rename and delete live on each existing card via
 * `BundleCardActions`.
 */
export async function BundleCards({ bundles }: { bundles: BundleRow[] }) {
  // The rule form needs the full party list (van wie) and the soort branch
  // (soort) regardless of what the bundles ALREADY reference — unlike
  // `describeRule`, which only needs the parties an existing rule names. Both
  // are fetched unconditionally now that the form is always on this view.
  const caller = await serverCaller();
  const [parties, tree] = await Promise.all([caller.parties.list(), caller.documents.tree()]);
  const partyNames = Object.fromEntries(parties.map((p) => [p.id, p.name]));
  // "Zonder soort" (the empty key) is a to-do list, not a condition anyone
  // would build a rule on — bundleRuleSchema's docType requires a non-empty
  // string besides.
  const docTypes = tree.soort.filter((s) => s.key !== "");

  if (bundles.length === 0) {
    return (
      <Empty title="Nog geen bundels"
        action={<BundleForm docTypes={docTypes} parties={parties} trigger="button" />}>
        Een bundel is een map met stukken — met de hand samengesteld, of
        automatisch volgens een regel.
      </Empty>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {bundles.map((b) => (
        <Panel key={b.id} className="flex flex-col gap-3 p-[18px]">
          <div className="flex items-baseline justify-between gap-2">
            <Label as="h2" className="truncate">{b.name}</Label>
            <span className="micro shrink-0">{b.kind === "manual" ? "handmatig" : "regel"}</span>
          </div>

          {b.broken ? (
            // A broken rule is the system explaining itself, not something
            // waiting on Martin — cyan, never amber. The count is suppressed:
            // it cannot be trusted while the rule cannot be read.
            <Notice tone="signal">De regel is niet leesbaar: {b.broken}</Notice>
          ) : (
            <>
              {b.kind === "rule" && b.rule && (
                // The system's own voice, same as the broken-rule Notice
                // above: a rule bundle must never be mistaken for a stack
                // somebody curated by hand.
                <p className="text-[13px] font-light leading-relaxed text-signal">
                  volgt een regel: {describeRule(b.rule, partyNames)}
                </p>
              )}
              <Micro>{b.count} {b.count === 1 ? "stuk" : "stukken"}</Micro>
            </>
          )}

          <div className="mt-auto flex items-center justify-between gap-2 pt-1">
            <a href={`/api/files/zip?bundle=${b.id}`}
              className={buttonClass("ghost", "sm", "self-start")}>
              Download .zip
            </a>
            <BundleCardActions bundle={{ id: b.id, name: b.name, note: b.note }} />
          </div>
        </Panel>
      ))}

      <BundleForm docTypes={docTypes} parties={parties} />
    </div>
  );
}
