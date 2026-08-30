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
import { CHANNEL_LABEL, CLARITY_LABEL, DIRECTION_LABEL, ENTRY_SOURCE_LABEL } from "@/lib/entry-labels";
import { orNotFound } from "@/lib/not-found";

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await serverCaller();
  // Three independent reads, so three at once. `tracks.map()` is the expensive
  // one — the whole map with its evidence batched — and it was the third wait
  // in a row on a page that shows one entry.
  const [e, parties, { map }] = await Promise.all([
    orNotFound(caller.entries.get({ id })),
    caller.parties.list(),
    caller.tracks.map(),
  ]);
  // Is this entry already a halte on the map? A halte belongs to a spoor, and
  // choosing the spoor is a decision this page cannot make for Martin — so it
  // reports the link and sends him to the map to make one, instead of the old
  // one-click "add to timeline" that a flat list could get away with.
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
          Deze regel is gecorrigeerd — bekijk{" "}
          <TextLink href={`/logbook/${e.supersededBy}`}>
            de correctie
          </TextLink>
          . Allebei blijven ze staan; juist dáárom is je logboek geloofwaardig.
        </Notice>
      )}

      <Panel lit className="flex flex-col gap-5 p-[26px]">
        <div className="flex flex-col gap-[14px]">
          <PageTitle className="leading-[1.15]">
            {e.summary}
          </PageTitle>
          <div className="flex flex-wrap items-center gap-[7px]">
            <Chip tone="mute">{CHANNEL_LABEL[e.channel] ?? e.channel}</Chip>
            <Chip tone="faint">{DIRECTION_LABEL[e.direction] ?? e.direction}</Chip>
          </div>
        </div>

        {/* Everything measured about the entry is mono; the prose below is not. */}
        <div className="grid gap-5 border-t border-hairline pt-[18px] sm:grid-cols-3">
          <div className="flex flex-col gap-[5px]">
            <Label>gebeurd op</Label>
            <div className="font-mono text-[12.5px] text-ink-soft">
              {new Date(e.occurredAt).toLocaleString("nl-NL")}
            </div>
          </div>
          <div className="flex flex-col gap-[5px]">
            <Label>vastgelegd op</Label>
            <div className="font-mono text-[12.5px] text-ink-soft">
              {new Date(e.recordedAt).toLocaleString("nl-NL")}
            </div>
          </div>
          <div className="flex flex-col gap-[5px]">
            <Label>bron</Label>
            <div className="font-mono text-[12.5px] text-ink-soft">{ENTRY_SOURCE_LABEL[e.source] ?? e.source}</div>
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
          <Label as="h2">Wie erbij waren</Label>
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
          <Label as="h2">Afgesproken acties</Label>
          {e.actionItems.length === 0 ? (
            <Micro>—</Micro>
          ) : (
            <div>
              {e.actionItems.map((a) => (
                <Row
                  key={a.id}
                  title={a.description}
                  kicker={`(${CLARITY_LABEL[a.clarity] ?? a.clarity}${a.dueAt ? `, vóór ${new Date(a.dueAt).toLocaleDateString("nl-NL")}` : ""})`}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel className="flex flex-col items-start gap-4 p-[26px]">
        {onMap ? (
          <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
            ✓ Staat als halte op de kaart —{" "}
            <TextLink
              href={`/timeline?stop=${encodeURIComponent(onMap.id)}`}>
              {onMap.title}
            </TextLink>
            {onMapTrack ? ` (${onMapTrack.title})` : ""}
          </p>
        ) : (
          <p className="text-[13.5px] font-light leading-relaxed text-ink-mute">
            Staat nog niet op de kaart. Een halte hoort bij een spoor, dus die
            voeg je daar toe —{" "}
            <TextLink href="/timeline">
              De zaak
            </TextLink>
            . Deze regel blijft hoe dan ook het bewijs.
          </p>
        )}
        {!e.supersededBy && (
          <Link href={`/logbook/new?correct=${e.id}`} className={buttonClass("ghost", "sm")}>
            Deze regel corrigeren
          </Link>
        )}
      </Panel>
    </article>
  );
}
