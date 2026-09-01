import Link from "next/link";
import { serverCaller } from "@/lib/trpc-server";
import { EnablePush } from "@/components/enable-push";
import { DashboardMoney } from "@/components/dashboard-money";
import { formatEuro } from "@/components/registry-list";
import { caseTopRows, noOpenTracksLine } from "@/lib/track-marks";
import { workerRowLabel } from "@/lib/worker-row-label";
import type { WorkerState } from "@verder/api/src/worker-health";
import {
  buttonClass,
  cx,
  type DotState,
  Dot,
  Empty,
  Label,
  Micro,
  Notice,
  PageTitle,
  Panel,
  PanelHead,
  Row,
  Stat,
  StatRow,
} from "@/components/ui";

/**
 * The task gauge.
 *
 * TWO ARCS, and both are fractions of the SAME number — the open tasks — so the
 * ring reads as one measurement instead of two scales sharing a circle. The
 * mockup carries four arcs; `tasks.stats` returns three numbers, and an arc
 * with nothing behind it would be a drawing pretending to be a measurement, so
 * the other two are simply not drawn.
 *
 * Amber is the overdue arc and nothing else here: an overdue task is the one
 * thing on this ring that is unambiguously waiting on Martin. What waits on
 * Verder is steel — "it is running, elsewhere".
 */
function TaskRing({
  open, overdue, waiting, label,
}: {
  open: number;
  overdue: number;
  waiting: number;
  label: string;
}) {
  const R = 80;
  const CIRCUMFERENCE = 2 * Math.PI * R;
  // Clamped: overdue and waiting are counted independently by the router, so a
  // task that is both would otherwise push the two arcs past a full turn.
  const arc = (n: number) => (open > 0 ? (Math.min(n, open) / open) * CIRCUMFERENCE : 0);
  const overdueLen = arc(overdue);
  const waitingLen = arc(Math.min(waiting, Math.max(open - overdue, 0)));

  return (
    <div className="relative size-[232px] shrink-0">
      <svg viewBox="0 0 232 232" className="absolute inset-0 size-full" aria-hidden="true">
        {/* Atmosphere: two rings turning against each other, carrying no fact. */}
        <g className="origin-center animate-spin-slow">
          <circle cx="116" cy="116" r="108" fill="none" strokeWidth="1"
            strokeDasharray="2 9" className="stroke-signal/20" />
        </g>
        <g className="origin-center animate-spin-back">
          <circle cx="116" cy="116" r="100" fill="none" strokeWidth="1"
            strokeDasharray="40 20" className="stroke-steel/15" />
        </g>
        <circle cx="116" cy="116" r="92" className="fill-signal/5" />
        {/* Rotated so the arcs start at twelve o'clock, where a reader starts. */}
        <g transform="rotate(-90 116 116)">
          <circle cx="116" cy="116" r={R} fill="none" strokeWidth="3" className="stroke-edge-strong" />
          {overdueLen > 0 ? (
            <circle cx="116" cy="116" r={R} fill="none" strokeWidth="3" strokeLinecap="round"
              className="stroke-attn"
              strokeDasharray={`${overdueLen} ${CIRCUMFERENCE - overdueLen}`} />
          ) : null}
          {waitingLen > 0 ? (
            <circle cx="116" cy="116" r={R} fill="none" strokeWidth="3" strokeLinecap="round"
              className="stroke-steel-dim"
              strokeDasharray={`${waitingLen} ${CIRCUMFERENCE - waitingLen}`}
              strokeDashoffset={-overdueLen} />
          ) : null}
        </g>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-[6px]">
        <div className="font-mono text-[44px] leading-none text-ink-bright">{open}</div>
        <Micro className="tracking-[0.24em]">{label}</Micro>
      </div>
    </div>
  );
}

/** One number written out beside the ring, with the mark its arc carries. */
function RingValue({
  label, value, tone,
}: {
  label: string;
  value: number;
  tone: "attn" | "steel";
}) {
  return (
    <div className="flex flex-col items-end gap-[5px]">
      <Label className={cx(tone === "attn" && "text-attn")}>{label}</Label>
      <div className="flex items-center gap-[9px]">
        <div className={cx("font-mono text-[16px]", tone === "attn" ? "text-attn" : "text-ink")}>
          {value}
        </div>
        <Dot state={tone === "attn" ? "you" : "waiting"} />
      </div>
    </div>
  );
}

/**
 * The served worker state, drawn.
 *
 * THE JUDGEMENT IS NOT MADE HERE ANY MORE, and that is the whole change. This
 * panel used to carry its own rule —
 * `down = (now - ranAt > 15 min) || status !== "ok"` — applied to all fifteen
 * rows. Measured on the homelab 2026-09-01: every row reported status ok and
 * NINE drew amber, purely on the age half; it had been six two days earlier and
 * drifted to nine with nothing broken. On this page amber means "work waiting
 * on Martin", so nine dots asked for attention that did not exist, and a wall
 * of meaningless amber is what teaches a reader to stop reading the panel.
 *
 * The rule now lives once, in packages/api/src/worker-health.ts, where it is
 * unit-tested against the taxonomy it belongs to and served as data. One list
 * judged in two places is how the two drift, and the drift stays invisible
 * until a dead watcher renders green. The panel's job is to DRAW a state, never
 * to decide one.
 *
 * `idle` and `off` both land on the neutral grey dot because neither is a
 * verdict: an on-demand job with no work and a retired worker are equally not
 * failing. They are told apart by the row's label and its opacity, not by
 * colour — the palette has exactly one amber and spending it on "no news" is
 * what broke this panel in the first place.
 */
const WORKER_DOT: Record<WorkerState, DotState> = {
  ok: "ok",
  down: "you",
  idle: "waiting",
  off: "waiting",
};

export default async function DashboardPage() {
  const caller = await serverCaller();
  // Six independent reads, and they used to run one after another — six full
  // round trips, the last of them the whole case map with its evidence batched,
  // before the landing page drew a single number. None of them depends on
  // another, so the page now waits once instead of six times.
  const [stats, registry, taskStats, clearedBlockers, recent, { map }] = await Promise.all([
    caller.dashboard.stats(),
    caller.registry.stats(),
    caller.tasks.stats(),
    caller.registry.clearedBlockers(),
    caller.entries.list({ limit: 5 }),
    caller.tracks.map(),
  ]);
  // One instant for the whole "Systeem" panel, mirroring the single `now` that
  // dashboard.stats uses to judge these same rows: two workers with the same
  // ran_at must never be LABELLED differently by a clock that ticked mid-map,
  // one landing on a clock time and the next on yesterday's date.
  const renderedAt = Date.now();
  // One line per open spoor: its newest stop that is not done yet, or its
  // newest stop if everything on it is done. `own[0]` can be undefined, because
  // a spoor with no haltes yet is a real state and the type should say so
  // instead of promising a stop that isn't there.
  const openTracks = map.tracks
    .filter((t) => t.status === "open" && t.parentTrackId !== null)
    .map((t) => {
      const own = map.stops.filter((s) => s.trackId === t.id)
        .sort((a, b) => a.row - b.row);
      // The newest stop that is not done yet, or the newest stop there is. Row 0
      // is the top of the page, so ascending row is newest first.
      return { track: t, stop: own.find((s) => s.state !== "done") ?? own[0] };
    });
  // The top of the timeline: what is running now, then the newest few dated
  // haltes. Same `tracks.map()` call as the list below it — the dashboard makes
  // one query for this whole block, never two.
  const topRows = caseTopRows({ stops: map.stops, tracks: map.tracks, datedLimit: 3 });
  // What the map itself says is waiting on Martin, looked up in the rows that
  // are already loaded — the hero shows THAT stop and no other. It can be null
  // (nothing open), and then the hero simply leads with the recent rows rather
  // than inventing something to wait for.
  const currentStop = map.stops.find((s) => s.id === map.currentStopId) ?? null;
  const currentTrack = currentStop
    ? map.tracks.find((t) => t.id === currentStop.trackId) ?? null
    : null;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageTitle>
          Hoi Martin 👋 — dit is hoe het ervoor staat
        </PageTitle>
        <EnablePush />
      </div>

      {/* The hero: what the case is waiting on, and how the tasks stand. The one
          lit panel and the one primary button on this page — the way onward
          from a landing page is the map, and everything else here is a reading. */}
      <Panel lit>
        <div className="grid gap-10 p-[30px] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:p-10">
          <div className="flex min-w-0 flex-col">
            {currentStop ? (
              <>
                <Label className="text-attn">wacht op jou</Label>
                {currentTrack ? (
                  <div className="mt-[14px] text-[19px] font-light leading-tight text-signal">
                    {currentTrack.title}
                  </div>
                ) : null}
                <div className="mt-[5px] text-[34px] font-extralight leading-[1.08] tracking-[-0.015em] text-ink-bright">
                  {currentStop.title}
                </div>
                {currentStop.note ? (
                  <p className="mt-[14px] max-w-[470px] text-[14.5px] font-light leading-relaxed text-ink-mute">
                    {currentStop.note}
                  </p>
                ) : null}
              </>
            ) : null}
            <div className="mt-6 flex flex-wrap gap-[10px]">
              <Link className={buttonClass("primary")} href="/timeline">
                de hele kaart →
              </Link>
            </div>
            {/* The newest rows of the case, in the hero's facts position: a
                fixed date column so they line up and read as a timeline and not
                as a paragraph. A running halte says "loopt nu" here instead of
                a date — it has none, and printing one would be the dashboard
                inventing it. */}
            {topRows.length > 0 && (
              <div className="mt-6 flex flex-col border-t border-hairline pt-[6px]">
                {topRows.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-baseline gap-x-3 border-b border-hairline py-[10px] last:border-0">
                    <span
                      className={cx(
                        "w-[86px] shrink-0 font-mono text-[10px] tracking-[0.14em] uppercase",
                        r.running ? "text-signal" : "text-ink-dim",
                      )}
                    >
                      {r.when}
                    </span>
                    <span
                      className={cx(
                        "text-[13.5px]",
                        r.running ? "text-ink-bright" : "font-light text-ink-soft",
                      )}
                    >
                      {r.title}
                    </span>
                    <span className="micro">· {r.spoor}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-8 lg:flex-nowrap">
            <div className="flex flex-col items-end gap-[17px]">
              <RingValue label="te laat" value={taskStats.overdueCount} tone="attn" />
              <RingValue label="wacht op anderen" value={taskStats.waitingOnOthersCount} tone="steel" />
            </div>
            <TaskRing
              open={taskStats.openCount}
              overdue={taskStats.overdueCount}
              waiting={taskStats.waitingOnOthersCount}
              label="taken open"
            />
          </div>
        </div>
      </Panel>

      {clearedBlockers.length > 0 && (
        // Amber, because a cleared blocker is a decision sitting on Martin's
        // desk — the one thing amber is for.
        <section className="flex flex-col gap-[10px]">
          {clearedBlockers.map((b) => (
            <Link key={b.id} href={`/registry/${b.id}`} className="block">
              <Notice tone="attn">
                <span className="text-ink-bright">{b.name}</span> — blokkade weg, klaar om te besluiten?{" "}
                <span className="text-ink-dim">(De notitie was: {b.blockerNote})</span>
              </Notice>
            </Link>
          ))}
        </section>
      )}

      <StatRow className="grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Link href="/queue" className="grid bg-void">
          <Stat label="te beoordelen" value={stats.pendingSuggestions} tone="signal" />
        </Link>
        <Link href="/files" className="grid bg-void">
          <Stat label="te sorteren" value={stats.inboxDocs} />
        </Link>
        {/* A <Link> like its four neighbours. As a bare <div> it was pixel-identical
            to them and did nothing when pressed, which reads as a broken tile
            rather than as a deliberate exception. */}
        <Link href="/tasks" className="grid bg-void">
          <Stat label="open acties" value={stats.openActionItems} />
        </Link>
        <Link href="/registry" className="grid bg-void">
          <Stat
            label="posten"
            value={registry.itemCount}
            sub={`${formatEuro(registry.monthlyTotalCents)}/mnd · ${registry.pendingDecisions} te besluiten`}
          />
        </Link>
        <Link href="/tasks" className="grid bg-void">
          <Stat
            label="taken open"
            value={taskStats.openCount}
            sub={
              <>
                <span className={cx(taskStats.overdueCount > 0 && "text-attn")}>
                  {taskStats.overdueCount} te laat
                </span>
                {" · "}
                {taskStats.waitingOnOthersCount} wacht op anderen
              </>
            }
          />
        </Link>
      </StatRow>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_1fr]">
        {/* Where the case stands: one line per open spoor. The dashboard shows
            LESS than /timeline on purpose: no map, no evidence, no problems —
            it points at the page that has them. */}
        <Panel className="p-[26px]">
          <div className="flex flex-col gap-[18px]">
            <PanelHead labelAs="h2" label="Waar de zaak staat" />
            {openTracks.length === 0 ? (
              // Names the outcomes that actually happened. "alles is afgerond"
              // asserted afgerond over a spoor whose status is `ended` — a
              // different, equally clean outcome that the rest of this work
              // keeps carefully apart.
              <Empty
                title={noOpenTracksLine(map.tracks
                  .filter((t) => t.parentTrackId !== null)
                  .map((t) => t.status))}
              />
            ) : (
              <div className="flex flex-col">
                {openTracks.map(({ track, stop }) => (
                  <Row
                    key={track.id}
                    state={stop?.id === map.currentStopId ? "you" : stop ? "open" : "waiting"}
                    title={stop ? stop.title : "nog geen halte"}
                    kicker={track.title}
                    meta={stop?.id === map.currentStopId ? "wacht op jou" : undefined}
                    metaTone="attn"
                  />
                ))}
              </div>
            )}
          </div>
        </Panel>

        <div className="flex flex-col gap-6">
          {/* Next to the registry tile, which counts the contracts: this shows
              what they actually cost against what comes in. */}
          <DashboardMoney />

          <Panel className="p-[26px]">
            <div className="flex flex-col gap-[14px]">
              <Label as="h2">Systeem</Label>
              <div className="flex flex-col gap-[11px]">
                {stats.lastWorkerRuns.map((w) => (
                  <div
                    key={w.worker}
                    // `off` is history, not health: a retired worker's last row
                    // is a fact about the past and must not sit at the same
                    // weight as the watchers that are actually reporting.
                    className={cx("flex items-center gap-3", w.state === "off" && "opacity-55")}
                  >
                    <Dot state={WORKER_DOT[w.state]} />
                    <span className="min-w-0 grow truncate font-mono text-[11px] tracking-[0.1em] uppercase text-ink-soft">
                      {w.worker}
                    </span>
                    {/* The whole row is passed, not just its kind: an amber dot
                        needs a reason as much as a grey one does, and only the
                        label can tell "stale" from "it reported an error" —
                        `fout · laatst 20:14` instead of a fresh timestamp
                        sitting inexplicably beside an amber dot. */}
                    <span
                      className={cx(
                        "shrink-0 font-mono text-[10px] tracking-[0.1em]",
                        w.state === "down" ? "text-attn" : "text-ink-dim",
                      )}
                    >
                      {workerRowLabel(w, renderedAt)}
                    </span>
                  </div>
                ))}
                {stats.lastWorkerRuns.length === 0 && (
                  <div className="flex items-center gap-3">
                    <Dot state="waiting" />
                    <span className="text-[13.5px] font-light text-ink-mute">
                      De watchers hebben zich nog niet gemeld.
                    </span>
                  </div>
                )}
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {/* "Recent key events" used to live here, reading the flat timeline that
          this sub-project replaced. It is gone rather than re-pointed at stops:
          the block at the top already says where every open spoor stands, and a
          second, date-ordered list of stops would be the dashboard telling the
          same story twice — once without the map that gives it its meaning. */}
      <section className="flex flex-col gap-[14px]">
        <Label as="h2">Laatst gelogd</Label>
        {/* The heading used to render unconditionally over a guarded list, so a
            dossier with no entries yet drew a title with nothing under it. */}
        {recent.length === 0 ? (
          <Empty title="Nog niets gelogd">
            Leg een telefoontje, een brief of een gesprek vast — dat is waar het
            bewijs vandaan komt.
          </Empty>
        ) : (
          <div className="grid gap-px bg-hairline-lit sm:grid-cols-2 lg:grid-cols-3">
            {recent.map((e) => (
              <Link
                key={e.id}
                href={`/logbook/${e.id}`}
                className="flex flex-col gap-[7px] bg-void px-5 py-4">
                <Micro>{new Date(e.occurredAt).toLocaleDateString("nl-NL")}</Micro>
                <span className="text-[13.5px] font-light leading-relaxed text-ink-soft">
                  {e.summary}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
