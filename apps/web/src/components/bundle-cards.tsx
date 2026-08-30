import { describeRule } from "@verder/api/src/bundle-rule";
import { serverCaller } from "@/lib/trpc-server";
import { Empty, Label, Micro, Notice, Panel, buttonClass } from "@/components/ui";

type Caller = Awaited<ReturnType<typeof serverCaller>>;
export type BundleRow = Awaited<ReturnType<Caller["bundles"]["list"]>>[number];

/**
 * The `bundels` view: one card per bundle. Minimal on purpose (Ruling 2) — a
 * later task adds the creation form, rename and delete; this one only reads.
 */
export async function BundleCards({ bundles }: { bundles: BundleRow[] }) {
  if (bundles.length === 0) {
    return (
      <Empty title="Nog geen bundels">
        Een bundel is een map met stukken — met de hand samengesteld, of
        automatisch volgens een regel.
      </Empty>
    );
  }

  // `describeRule` names the sender of a rule bundle by id; the name itself
  // lives in `parties` and is fetched only when a rule actually needs it.
  const needsParties = bundles.some((b) => b.kind === "rule" && b.rule?.partyId);
  const parties = needsParties ? await (await serverCaller()).parties.list() : [];
  const partyNames = Object.fromEntries(parties.map((p) => [p.id, p.name]));

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
                <p className="text-[13px] font-light leading-relaxed text-ink-mute">
                  {describeRule(b.rule, partyNames)}
                </p>
              )}
              <Micro>{b.count} {b.count === 1 ? "stuk" : "stukken"}</Micro>
            </>
          )}

          <a href={`/api/files/zip?bundle=${b.id}`}
            className={buttonClass("ghost", "sm", "self-start")}>
            Download .zip
          </a>
        </Panel>
      ))}
    </div>
  );
}
