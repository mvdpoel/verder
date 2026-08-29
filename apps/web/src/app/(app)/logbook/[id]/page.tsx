import Link from "next/link";
import {
  buttonClass,
  Chip,
  Label,
  Micro,
  Notice,
  PageTitle,
  Panel,
  Row,
  TextLink,
} from "@/components/ui";
import { serverCaller } from "@/lib/trpc-server";

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  const e = await caller.entries.get({ id });
  const parties = await caller.parties.list();
  // Is this entry already a halte on the map? A halte belongs to a spoor, and
  // choosing the spoor is a decision this page cannot make for Martin — so it
  // reports the link and sends him to the map to make one, instead of the old
  // one-click "add to timeline" that a flat list could get away with.
  const { map } = await caller.tracks.map();
  const onMap = map.stops.find((s) => s.entryId === id) ?? null;
  const onMapTrack = onMap ? map.tracks.find((t) => t.id === onMap.trackId) : null;
  const nameOf = (pid: string) => parties.find((p) => p.id === pid)?.name ?? pid;
  return (
    <article className="flex max-w-3xl flex-col gap-5">
      {e.supersededBy && (
        /*
         * A correction is not a warning. The original standing beside its
         * correction is exactly what makes this log evidence, so this reads in
         * the ink ramp with a cyan way onward — amber here would say "you have
         * to do something", and there is nothing to do.
         */
        <Notice tone="signal">
          This entry was corrected — see{" "}
          <TextLink href={`/logbook/${e.supersededBy}`}>
            the correction
          </TextLink>
          . Both stay on record; that&apos;s what makes your log credible.
        </Notice>
      )}

      <Panel lit className="flex flex-col gap-5 p-[26px]">
        <div className="flex flex-col gap-[14px]">
          <PageTitle className="leading-[1.15]">
            {e.summary}
          </PageTitle>
          <div className="flex flex-wrap items-center gap-[7px]">
            <Chip tone="mute">{e.channel}</Chip>
            <Chip tone="faint">{e.direction}</Chip>
          </div>
        </div>

        {/* Everything measured about the entry is mono; the prose below is not. */}
        <div className="grid gap-5 border-t border-hairline pt-[18px] sm:grid-cols-3">
          <div className="flex flex-col gap-[5px]">
            <Label>happened</Label>
            <div className="font-mono text-[12.5px] text-ink-soft">
              {new Date(e.occurredAt).toLocaleString("nl-NL")}
            </div>
          </div>
          <div className="flex flex-col gap-[5px]">
            <Label>logged</Label>
            <div className="font-mono text-[12.5px] text-ink-soft">
              {new Date(e.recordedAt).toLocaleString("nl-NL")}
            </div>
          </div>
          <div className="flex flex-col gap-[5px]">
            <Label>source</Label>
            <div className="font-mono text-[12.5px] text-ink-soft">{e.source}</div>
          </div>
        </div>

        {e.details && (
          <p className="whitespace-pre-wrap border-t border-hairline pt-[18px] text-[14px] font-light leading-relaxed text-ink-mute">
            {e.details}
          </p>
        )}
      </Panel>

      <div className="grid gap-5 md:grid-cols-2">
        <Panel className="flex flex-col gap-[14px] p-[26px]">
          {/* Still an h2: the small caps are the style, not a demotion. */}
          <Label as="h2">Who was involved</Label>
          {e.participants.length === 0 ? (
            <Micro>—</Micro>
          ) : (
            <ul className="flex flex-wrap gap-[7px]">
              {e.participants.map((p) => (
                <li key={p.partyId}>
                  <Chip tone="mute">{nameOf(p.partyId)}</Chip>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel className="flex flex-col gap-2 p-[26px]">
          <Label as="h2">Agreed actions</Label>
          {e.actionItems.length === 0 ? (
            <Micro>—</Micro>
          ) : (
            <div>
              {e.actionItems.map((a) => (
                <Row
                  key={a.id}
                  title={a.description}
                  kicker={`(${a.clarity}${a.dueAt ? `, due ${new Date(a.dueAt).toLocaleDateString("nl-NL")}` : ""})`}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel className="flex flex-col items-start gap-4 p-[26px]">
        {onMap ? (
          <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
            ✓ On the map as a halte —{" "}
            <TextLink
              href={`/timeline?stop=${encodeURIComponent(onMap.id)}`}>
              {onMap.title}
            </TextLink>
            {onMapTrack ? ` (${onMapTrack.title})` : ""}
          </p>
        ) : (
          <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
            Not on the map yet. A halte belongs to a spoor, so you add it there —{" "}
            <TextLink href="/timeline">
              De zaak
            </TextLink>
            . This entry stays the evidence either way.
          </p>
        )}
        {!e.supersededBy && (
          <Link href={`/logbook/new?correct=${e.id}`} className={buttonClass("ghost", "sm")}>
            Correct this entry
          </Link>
        )}
      </Panel>
    </article>
  );
}
