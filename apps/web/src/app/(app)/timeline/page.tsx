import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { TrackMap, type MapPayload } from "@/components/track-map";
import { STOP_STATE_LABEL, TRACK_STATUS_LABEL, stopHref } from "@/lib/track-marks";
import { AddTrackForm, TrackEditor } from "@/components/track-editor";
import { AddStopForm, StopEditor } from "@/components/stop-editor";

/**
 * De zaak als metrokaart. The main line runs to Einde bewindvoering; a side
 * track branches off when something arrives, runs its stops, and either merges
 * back (it was a prerequisite) or ends.
 *
 * Everything here is derived on read from tracks + stops and the evidence they
 * point at. Nothing on this page writes evidence or appends a ledger event: a
 * stop points, it never asserts.
 *
 * The page OPENS ON WHAT IS WAITING. That block sits above the map because it
 * is the question this page is opened to answer; the map is the context for the
 * answer, not the answer itself.
 */

type MapStop = MapPayload["stops"][number];

/**
 * Where a new halte lands on a spoor.
 *
 * The router appends at max+1 when it is given nothing, and on the hoofdlijn
 * that means AFTER *Einde bewindvoering*, which migration 0023 parked at
 * order_index 1000000. So when a spoor ends on something still verwacht — the
 * endpoint everything else happens before — the new halte goes in front of it.
 * The seed leaves wide gaps (0, 1..n, 1000000) precisely so this needs no
 * renumbering of anything already there.
 */
function insertPosition(own: MapStop[]): number | undefined {
  const last = own.at(-1);
  // No haltes yet, or this spoor ends on something that already happened:
  // appending is exactly right, so let the router do it.
  if (!last || last.state !== "expected") return undefined;
  const floor = own.at(-2)?.orderIndex ?? -1;
  // No room left between the two? Share the endpoint's slot: the map breaks
  // that tie on date, and a dated halte sorts ahead of an undated endpoint.
  return floor + 1 < last.orderIndex ? floor + 1 : last.orderIndex;
}

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ stop?: string }>;
}) {
  const { stop } = await searchParams;
  const caller = await serverCaller();
  const { map, evidence } = await caller.tracks.map();

  const selected = stop && map.stops.some((s) => s.id === stop) ? stop : null;
  const current = map.stops.find((s) => s.id === map.currentStopId) ?? null;
  const shown = map.stops.find((s) => s.id === selected) ?? current;
  const shownTrack = shown ? map.tracks.find((t) => t.id === shown.trackId) : null;
  const shownEvidence = shown ? evidence[shown.id] : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">De zaak</h1>
        <p className="mt-1 text-slate-600">
          De hoofdlijn loopt naar het einde van de bewindvoering. Een zijspoor
          begint zodra er iets binnenkomt — een mail, een telefoontje, een brief —
          en komt daarna terug op de hoofdlijn of eindigt op zichzelf.
        </p>
      </div>

      {/* What is waiting on Martin, said before the map rather than hidden in
          it. The link selects that halte; it never clears the selection, so
          this block always leads somewhere. */}
      {current ? (
        <Link
          href={stopHref(current.id, null)}
          className="block rounded border border-l-4 border-l-green-600 bg-white p-4 hover:bg-slate-50"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Waar het nu op wacht
          </p>
          <p className="mt-1 font-medium">{current.title}</p>
          <p className="text-sm text-slate-600">
            {map.tracks.find((t) => t.id === current.trackId)?.title}
          </p>
        </Link>
      ) : (
        <div className="rounded border bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Waar het nu op wacht
          </p>
          {/* Reports, never judges: nothing open is a state of the case, not a
              gap in the bookkeeping. */}
          <p className="mt-1 text-sm text-slate-600">
            Er staat op dit moment geen halte open. Zodra er iets binnenkomt of
            je zet een halte op “loopt nog”, staat het hier.
          </p>
        </div>
      )}

      <TrackMap map={map} selected={selected} />

      {shown && (
        <section className="rounded border bg-white p-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-semibold">{shown.title}</h2>
            <span className="text-sm text-slate-500">
              {shownTrack?.title} · {STOP_STATE_LABEL[shown.state] ?? shown.state}
              {shown.happenedAt
                ? ` · ${new Date(shown.happenedAt).toLocaleDateString("nl-NL")}`
                : shown.expectedAt
                  ? ` · verwacht ${new Date(shown.expectedAt).toLocaleDateString("nl-NL")}`
                  : ""}
            </span>
            {selected && (
              <Link href="/timeline" className="ml-auto text-sm text-slate-500 hover:underline">
                sluiten
              </Link>
            )}
          </div>
          {shown.note && <p className="mt-2 text-sm text-slate-600">{shown.note}</p>}

          {shown.datesOutOfOrder && (
            <p className="mt-2 text-sm text-red-700">
              De datum van deze halte ligt vóór de halte ervoor. De kaart tekent de
              volgorde zoals hij is ingevoerd — meestal betekent dit dat deze halte
              op een ander spoor thuishoort.
            </p>
          )}

          {/* The third level: the entry, the task, the mail and its files.
              Derived on read, so it cannot go stale — and REAL links, so this
              is reachable with a keyboard, the lesson /money's month labels
              already learned. */}
          <div className="mt-3 space-y-2 text-sm">
            {shownEvidence?.entry && (
              <Link className="block text-slate-600 hover:underline"
                href={`/logbook/${shownEvidence.entry.id}`}>
                → logboek: {shownEvidence.entry.summary}
              </Link>
            )}
            {shownEvidence?.task && (
              <Link className="block text-slate-600 hover:underline"
                href={`/tasks/${shownEvidence.task.id}`}>
                → taak: {shownEvidence.task.title} ({shownEvidence.task.status})
              </Link>
            )}
            {/* Not a link: the app has no page for a raw e-mail. The files that
                came off it are listed under it, and those do have one. */}
            {shownEvidence?.email && (
              <p className="text-slate-600">
                → e-mail: {shownEvidence.email.subject}{" "}
                <span className="text-xs text-slate-400">
                  van {shownEvidence.email.fromAddr}
                </span>
              </p>
            )}
            {shownEvidence?.documents.map((d) => (
              <Link key={d.id} className="block text-slate-600 hover:underline"
                href={`/vault/${d.id}`}>
                → bestand: {d.title}
              </Link>
            ))}
            {shownEvidence &&
              !shownEvidence.entry && !shownEvidence.task &&
              !shownEvidence.email && shownEvidence.documents.length === 0 && (
              <p className="text-slate-500">
                Verwacht — nog niets achter deze halte. Zodra er een mail, een taak
                of een document aan hangt staat het hier.
              </p>
            )}
          </div>

          {/* `links` is only there so a koppeling that falls outside the
              picker's page of candidates still shows its own name. The editor
              saves IDs and nothing else. */}
          <div className="mt-3">
            {/* keyed on the halte: selecting another one must give a fresh
                form. Without it React keeps the editor's state across the
                switch and Opslaan would write the previous halte's title —
                and now its koppelingen — onto this one. */}
            <StopEditor key={shown.id} stop={shown} links={shownEvidence ?? null} />
          </div>
        </section>
      )}

      {/* TrackMap draws nothing when there is no hoofdlijn, so the page — not
          the drawing — is what says why. */}
      {map.problems.length > 0 && (
        <section className="rounded border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold">Wat de kaart niet kon tekenen</h2>
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            {map.problems.map((p, n) => <li key={n}>{p.detail}</li>)}
          </ul>
        </section>
      )}

      <section className="rounded border bg-white p-4">
        <h2 className="font-semibold">Sporen</h2>
        <ul className="mt-2 space-y-2">
          {map.tracks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-2 text-sm">
              <span className="font-medium">{t.title}</span>
              <span className="text-slate-500">
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
              <span className="ml-auto flex flex-wrap gap-2">
                <AddStopForm
                  trackId={t.id}
                  orderIndex={insertPosition(map.stops.filter((s) => s.trackId === t.id))}
                />
                <TrackEditor track={t} stops={map.stops} />
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3"><AddTrackForm stops={map.stops} /></div>
      </section>
    </div>
  );
}
