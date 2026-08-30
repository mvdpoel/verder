import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { TrackMap } from "@/components/track-map";
import { STOP_STATE_LABEL, TRACK_STATUS_LABEL, schuldeisersHref, stopHref } from "@/lib/track-marks";
import { AddTrackForm, TrackEditor } from "@/components/track-editor";
import { AddStopForm, StopEditor } from "@/components/stop-editor";
import { Label, Notice, PageTitle, Panel, TextLink } from "@/components/ui";

/**
 * De zaak als verticale metrokaart: het nieuwste bovenaan, per maand omlaag.
 *
 * The main line is how the bewindvoering itself ran — from the aanmelding at
 * Verder to where it stands now. It has no goal stop: the map shows history
 * and the current situation only. A side track branches off when something
 * arrives, runs its stops, and either merges back (it was a prerequisite) or ends.
 *
 * Everything here is derived on read from tracks + stops and the evidence they
 * point at. Nothing on this page writes evidence or appends a ledger event: a
 * stop points, it never asserts.
 *
 * The page OPENS ON WHAT IS WAITING. That block sits above the map because it
 * is the question this page is opened to answer; the map is the context for the
 * answer, not the answer itself. It is the page's ONE lit panel and the page's
 * only amber, for the same reason: on this screen there is exactly one thing
 * waiting on Martin, and it is that.
 */

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ stop?: string; schuldeisers?: string }>;
}) {
  const { stop, schuldeisers } = await searchParams;
  const hideDebtEpisodes = schuldeisers === "verborgen";
  const caller = await serverCaller();
  const { map, evidence, hiddenDebtTrackCount } = await caller.tracks.map({ hideDebtEpisodes });

  const selected = stop && map.stops.some((s) => s.id === stop) ? stop : null;
  const current = map.stops.find((s) => s.id === map.currentStopId) ?? null;
  const shown = map.stops.find((s) => s.id === selected) ?? current;
  const shownTrack = shown ? map.tracks.find((t) => t.id === shown.trackId) : null;
  const shownEvidence = shown ? evidence[shown.id] : null;
  const currentTrack = current ? map.tracks.find((t) => t.id === current.trackId) : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <PageTitle className="leading-tight">
          De zaak
        </PageTitle>
        <p className="max-w-3xl text-[13.5px] font-light leading-relaxed text-ink-mute">
          Het nieuwste staat bovenaan. De hoofdlijn is hoe de bewindvoering zelf
          is gelopen — van de aanmelding bij Verder tot waar het nu staat. Een
          zijspoor begint zodra er iets binnenkomt — een mail, een telefoontje,
          een brief — en komt daarna terug op de hoofdlijn of eindigt op zichzelf.
          Wat nog moet gebeuren staat er niet op: deze kaart laat zien wat er is
          gebeurd.
        </p>
        {/* The setting lives in the URL, same rule as ?stop=, so the view stays
            linkable. The count is said out loud so nothing disappears silently. */}
        <p className="font-mono text-[10px] tracking-[0.16em] uppercase">
          <TextLink
            href={schuldeisersHref(hideDebtEpisodes, selected)}>
            {hideDebtEpisodes ? "schuldeisersmeldingen tonen" : "schuldeisersmeldingen verbergen"}
          </TextLink>
          {hideDebtEpisodes && (
            <span className="ml-2 text-ink-dim">
              ({hiddenDebtTrackCount} {hiddenDebtTrackCount === 1 ? "spoor" : "sporen"} verborgen)
            </span>
          )}
        </p>
      </header>

      {/* What is waiting on Martin, said before the map rather than hidden in
          it. The link selects that halte; it never clears the selection, so
          this block always leads somewhere. */}
      {current ? (
        <Link href={stopHref(current.id, null)} className="block">
          <Panel lit className="p-[26px] transition-colors hover:border-signal/40">
            <Label className="text-attn">Waar het nu op wacht</Label>
            {/* Spoor above the halte, the way the hero on the dashboard reads:
                the small line names the context, the big line names the thing. */}
            <p className="mt-[14px] text-[19px] font-light leading-tight text-signal">
              {currentTrack?.title}
            </p>
            <p className="mt-[5px] text-[34px] font-extralight leading-[1.08] tracking-[-0.015em] text-ink-bright">
              {current.title}
            </p>
          </Panel>
        </Link>
      ) : (
        <Panel className="p-[26px]">
          {/* No amber here: nothing is waiting, so the label carries no urgency. */}
          <Label>Waar het nu op wacht</Label>
          {/* Reports, never judges: nothing open is a state of the case, not a
              gap in the bookkeeping. */}
          <p className="mt-3 max-w-2xl text-[13.5px] font-light leading-relaxed text-ink-mute">
            Er staat op dit moment geen halte open. Zodra er iets binnenkomt of
            je zet een halte op “loopt nog”, staat het hier.
          </p>
        </Panel>
      )}

      <TrackMap map={map} selected={selected} />

      {shown && (
        <section>
          <Panel className="p-[26px]">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <h2 className="text-[19px] font-light leading-tight text-ink-bright">{shown.title}</h2>
              <span className="micro">
                {shownTrack?.title} · {STOP_STATE_LABEL[shown.state] ?? shown.state}
                {shown.happenedAt
                  ? ` · ${new Date(shown.happenedAt).toLocaleDateString("nl-NL")}`
                  : ""}
              </span>
              {selected && (
                <TextLink
                  href="/timeline"
                  className="ml-auto font-mono text-[10px] tracking-[0.16em] uppercase">
                  sluiten
                </TextLink>
              )}
            </div>
            {shown.note && (
              <p className="mt-3 max-w-3xl text-[13.5px] font-light leading-relaxed text-ink-mute">
                {shown.note}
              </p>
            )}

            {/* Amber, and one of the two places on this page that earns it: a
                date that contradicts the halte before it is Martin's to fix,
                and the map will keep drawing it wrong until he does. */}
            {shown.datesOutOfOrder && (
              <Notice tone="attn" className="mt-4">
                De datum van deze halte ligt vóór de halte ervoor. De kaart tekent de
                volgorde zoals hij is ingevoerd — meestal betekent dit dat deze halte
                op een ander spoor thuishoort.
              </Notice>
            )}

            {/* The third level: the entry, the task, the mail and its files.
                Derived on read, so it cannot go stale — and REAL links, so this
                is reachable with a keyboard, the lesson /money's month labels
                already learned. */}
            <div className="mt-4 flex flex-col gap-2">
              {shownEvidence?.entry && (
                <TextLink
                  className="block text-[13.5px] font-light"
                  href={`/logbook/${shownEvidence.entry.id}`}>
                  → logboek: {shownEvidence.entry.summary}
                </TextLink>
              )}
              {shownEvidence?.task && (
                <TextLink
                  className="block text-[13.5px] font-light"
                  href={`/tasks/${shownEvidence.task.id}`}>
                  → taak: {shownEvidence.task.title} ({shownEvidence.task.status})
                </TextLink>
              )}
              {/* Not a link: the app has no page for a raw e-mail. The files that
                  came off it are listed under it, and those do have one. Steel,
                  not cyan, because cyan on this page is the way onward. */}
              {shownEvidence?.email && (
                <p className="text-[13.5px] font-light text-ink-soft">
                  → e-mail: {shownEvidence.email.subject}{" "}
                  <span className="micro">van {shownEvidence.email.fromAddr}</span>
                </p>
              )}
              {shownEvidence?.documents.map((d) => (
                <TextLink
                  key={d.id}
                  className="block text-[13.5px] font-light"
                  href={`/files/${d.id}`}>
                  → bestand: {d.title}
                </TextLink>
              ))}
              {shownEvidence &&
                !shownEvidence.entry && !shownEvidence.task &&
                !shownEvidence.email && shownEvidence.documents.length === 0 && (
                <p className="max-w-2xl text-[13px] font-light leading-relaxed text-ink-label">
                  Verwacht — nog niets achter deze halte. Zodra er een mail, een taak
                  of een document aan hangt staat het hier.
                </p>
              )}
            </div>

            {/* `links` is only there so a koppeling that falls outside the
                picker's page of candidates still shows its own name. The editor
                saves IDs and nothing else. */}
            <div className="mt-5">
              {/* keyed on the halte: selecting another one must give a fresh
                  form. Without it React keeps the editor's state across the
                  switch and Opslaan would write the previous halte's title —
                  and now its koppelingen — onto this one. */}
              <StopEditor key={shown.id} stop={shown} links={shownEvidence ?? null} />
            </div>
          </Panel>
        </section>
      )}

      {/* TrackMap draws nothing when there is no hoofdlijn, so the page — not
          the drawing — is what says why. This block is deliberately NOT amber:
          it reports what the drawing could not resolve, which is a fact about
          the map and not a job sitting in Martin's queue. */}
      {map.problems.length > 0 && (
        <section>
          <Panel className="p-[26px]">
            <Label as="h2">Wat de kaart niet kon tekenen</Label>
            <ul className="mt-3 flex flex-col gap-2">
              {map.problems.map((p, n) => (
                <li key={n} className="text-[13px] font-light leading-relaxed text-ink-mute">
                  {p.detail}
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      )}

      <section>
        <Panel className="p-[26px]">
          <Label as="h2">Sporen</Label>
          <ul className="mt-3">
            {map.tracks.map((t) => (
              <li key={t.id} className="border-b border-hairline py-[13px] last:border-0">
                {/* A div and not a span around the two editors: both expand into
                    a block form in place, and a block inside a span is not
                    something a browser is obliged to lay out sanely. */}
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
                  <span className="text-sm text-ink-soft">{t.title}</span>
                  {/* A span and not <Micro>: this sits on the same baseline as
                      the title, and Micro is a block. */}
                  <span className="micro">
                    {t.parentTrackId === null
                      ? "hoofdlijn"
                      : t.mergesBack
                        ? "komt terug op de hoofdlijn"
                        : "eindigt op zichzelf"}
                    {/* The status in words. The map draws afgerond and geëindigd
                        with different caps, and this is where that difference is
                        readable without a mouse — they are different facts and the
                        spoor editor asks Martin to choose between them. */}
                    {" · "}
                    {TRACK_STATUS_LABEL[t.status] ?? t.status}
                  </span>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <AddStopForm trackId={t.id} />
                    <TrackEditor track={t} stops={map.stops} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4"><AddTrackForm stops={map.stops} /></div>
        </Panel>
      </section>
    </div>
  );
}
